/**
 * Key Manager - Handles provider key loading, selection, and rate limiting
 * Uses dynamic priority rotation: failed keys move to end of queue
 */

import { ProviderKey, IProviderKey } from '../models/provider-key';
import { ApiUsage } from '../models/api-usage';
import type { KeyConfig } from './types';
import { log } from '../../../lib/logger.js';

// Cache for loaded keys (TTL: 30 seconds)
const keyCache = new Map<string, { keys: IProviderKey[]; timestamp: number }>();
const KEY_CACHE_TTL = 30000;

/**
 * Load all available keys for a provider from MongoDB
 * Keys are sorted by: 1) Free first, then paid 2) currentPriority within each group
 */
export async function loadProviderKeys(provider: string): Promise<IProviderKey[]> {
  const cacheKey = `provider:${provider}`;
  const cached = keyCache.get(cacheKey);

  // Return cached if still valid
  if (cached && Date.now() - cached.timestamp < KEY_CACHE_TTL) {
    return cached.keys;
  }

  // Query MongoDB - exclude archived keys
  const allKeys = await ProviderKey.find({
    provider,
    isArchived: false,
    isActive: true,
  });

  // Separate free and paid keys, sort each group by currentPriority
  const freeKeys = allKeys
    .filter((k) => !k.isPaid)
    .sort((a, b) => a.currentPriority - b.currentPriority);

  const paidKeys = allKeys
    .filter((k) => k.isPaid)
    .sort((a, b) => a.currentPriority - b.currentPriority);

  // Free keys first, then paid keys
  const keys = [...freeKeys, ...paidKeys];

  // Cache the results
  keyCache.set(cacheKey, { keys, timestamp: Date.now() });

  return keys;
}

/**
 * Check if a key has exceeded rate limits.
 * Uses a single $facet aggregation to check all limits in one DB round-trip.
 */
async function isKeyRateLimited(key: IProviderKey, tokens: number = 0): Promise<boolean> {
  // No limits configured = not rate limited
  if (!key.rateLimit.rpm && !key.rateLimit.rpd && !key.rateLimit.tpm && !key.rateLimit.tpd) {
    return false;
  }

  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60000);
  const oneDayAgo = new Date(now - 86400000);

  // Single aggregation with $facet to check all limits at once
  const [result] = await ApiUsage.aggregate([
    { $match: { keyId: key._id, timestamp: { $gte: oneDayAgo } } },
    { $facet: {
      minuteStats: [
        { $match: { timestamp: { $gte: oneMinuteAgo } } },
        { $group: { _id: null, count: { $sum: 1 }, tokens: { $sum: '$tokens' } } }
      ],
      dayStats: [
        { $group: { _id: null, count: { $sum: 1 }, tokens: { $sum: '$tokens' } } }
      ]
    }}
  ]);

  const minute = result?.minuteStats?.[0] || { count: 0, tokens: 0 };
  const day = result?.dayStats?.[0] || { count: 0, tokens: 0 };

  if (key.rateLimit.rpm && minute.count >= key.rateLimit.rpm) return true;
  if (key.rateLimit.rpd && day.count >= key.rateLimit.rpd) return true;
  if (key.rateLimit.tpm && tokens > 0 && minute.tokens + tokens > key.rateLimit.tpm) return true;
  if (key.rateLimit.tpd && tokens > 0 && day.tokens + tokens > key.rateLimit.tpd) return true;

  return false;
}

/**
 * Get the best available key for a provider/model combination
 * Keys are already sorted by currentPriority (dynamic rotation)
 */
export async function getBestKeyForModel(
  provider: string,
  modelId: string,
  estimatedTokens: number = 0
): Promise<KeyConfig | null> {
  const keys = await loadProviderKeys(provider);

  if (keys.length === 0) {
    log.keys.warn({ provider }, 'No keys found for provider');
    return null;
  }

  // Try keys in order of currentPriority (already sorted)
  // Failed keys will have been moved to end of queue
  const now = new Date();
  for (const key of keys) {
    // Skip keys in cooldown period
    if (key.cooldownUntil && key.cooldownUntil > now) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownUntil: key.cooldownUntil }, 'Key in cooldown, skipping');
      continue;
    }

    // Skip keys that have exceeded their credit limit
    if (key.creditLimitUSD != null && key.spentUSD >= key.creditLimitUSD) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, spentUSD: key.spentUSD, creditLimitUSD: key.creditLimitUSD }, 'Key credit exhausted, skipping');
      continue;
    }

    // Check rate limits
    const isLimited = await isKeyRateLimited(key, estimatedTokens);
    if (isLimited) {
      continue;
    }

    // Skip keys without a stored key value
    if (!key.key) {
      log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Key has no value, skipping');
      continue;
    }

    // Found a suitable key
    return {
      keyId: key._id.toString(),
      provider: key.provider,
      modelId,
      key: key.key,
      isPaid: key.isPaid,
      rpm: key.rateLimit.rpm,
      rpd: key.rateLimit.rpd,
      tpm: key.rateLimit.tpm,
      tpd: key.rateLimit.tpd,
    };
  }

  log.keys.warn({ provider }, 'All keys rate-limited or in cooldown');
  return null;
}

/**
 * Record key usage for rate limiting
 */
export async function recordKeyUsage(
  keyId: string,
  tokens: number,
  provider: string,
  modelId: string
): Promise<void> {
  await ApiUsage.create({
    keyId,
    provider,
    modelId,
    tokens,
    timestamp: new Date(),
  });

  // Update key statistics (fire and forget)
  ProviderKey.findByIdAndUpdate(keyId, {
    $set: { lastUsedAt: new Date() },
    $inc: { totalRequests: 1, totalTokens: tokens },
  }).catch((err) => log.keys.error({ err }, 'Failed to update key stats'));
}

/**
 * Record key success (resets failure counters, restores original priority, clears cooldown)
 */
export async function recordKeySuccess(keyId: string): Promise<void> {
  try {
    const key = await ProviderKey.findById(keyId);
    if (key) {
      await key.recordSuccess();

      // Clear cooldown atomically
      await ProviderKey.updateOne(
        { _id: keyId },
        { $set: { cooldownUntil: null } }
      );

      // Invalidate cache to pick up priority changes
      invalidateKeyCache(key.provider);
    }
  } catch (error: any) {
    log.keys.error({ err: error }, 'Failed to record key success');
  }
}

/**
 * Record key failure (moves key to last priority within its group - free or paid)
 * Also sets exponential cooldown: 30s * 2^consecutiveFailures, max 30min
 */
export async function recordKeyFailure(keyId: string, reason: string): Promise<void> {
  try {
    const key = await ProviderKey.findById(keyId);
    if (!key) {
      log.keys.warn({ keyId }, 'Key not found');
      return;
    }

    // Get max priority within the same group (free or paid)
    const maxKey = await ProviderKey.findOne({
      provider: key.provider,
      isPaid: key.isPaid, // Same group (free or paid)
      isArchived: false,
    })
      .sort({ currentPriority: -1 })
      .select('currentPriority');

    const maxPriority = maxKey?.currentPriority || 999;

    // Record failure and move to end of its group's queue
    await key.recordFailure(reason, maxPriority);

    // Set cooldown with exponential backoff (atomic $set)
    // 30s base, doubles per consecutive failure, capped at 30min
    const consecutiveFailures = (key.consecutiveFailures || 0) + 1; // +1 because recordFailure already incremented
    const cooldownMs = Math.min(30000 * Math.pow(2, consecutiveFailures - 1), 1800000);
    const cooldownUntil = new Date(Date.now() + cooldownMs);

    await ProviderKey.updateOne(
      { _id: keyId },
      { $set: { cooldownUntil } }
    );

    log.keys.info({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownSec: cooldownMs / 1000 }, 'Key cooldown set');

    // Invalidate cache to pick up priority changes
    invalidateKeyCache(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Failed to record key failure');
  }
}

/**
 * Get statistics for a provider's keys
 */
export async function getProviderKeyStats(provider: string): Promise<any> {
  const keys = await ProviderKey.find({ provider, isArchived: false });

  return {
    total: keys.length,
    active: keys.filter((k) => k.isActive).length,
    rateLimited: 0, // Would need to check actual rate limits
    averageSuccessRate:
      keys.reduce((sum, k) => {
        const total = k.successCount + k.totalFailures;
        return sum + (total > 0 ? k.successCount / total : 1);
      }, 0) / keys.length,
    totalRequests: keys.reduce((sum, k) => sum + k.totalRequests, 0),
    totalFailures: keys.reduce((sum, k) => sum + k.totalFailures, 0),
  };
}

/**
 * Record key spend (fire and forget) - increments spentUSD on the key
 */
export async function recordKeySpend(keyId: string, costUSD: number): Promise<void> {
  if (costUSD <= 0) return;
  ProviderKey.findByIdAndUpdate(keyId, {
    $inc: { spentUSD: costUSD },
  }).catch((err) => log.keys.error({ err }, 'Failed to update key spend'));
}

/**
 * Mark a key as credit-exhausted (set spentUSD = creditLimitUSD)
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  try {
    const key = await ProviderKey.findById(keyId);
    if (key && key.creditLimitUSD != null) {
      await ProviderKey.updateOne(
        { _id: keyId },
        { $set: { spentUSD: key.creditLimitUSD } }
      );
      invalidateKeyCache(key.provider);
      log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider, creditLimitUSD: key.creditLimitUSD }, 'Key marked as credit exhausted');
    }
  } catch (err) {
    log.keys.error({ err }, 'Failed to mark key as credit exhausted');
  }
}

/**
 * Invalidate key cache (call after adding/removing/modifying keys)
 */
export function invalidateKeyCache(provider?: string): void {
  if (provider) {
    keyCache.delete(`provider:${provider}`);
  } else {
    keyCache.clear();
  }
}
