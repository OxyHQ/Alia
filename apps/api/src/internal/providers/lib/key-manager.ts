/**
 * Key Manager - Handles provider key loading, selection, and rate limiting
 * Uses dynamic priority rotation: failed keys move to end of queue
 */

import { ProviderKey, IProviderKey } from '../models/provider-key';
import { ApiUsage } from '../models/api-usage';
import { decryptKey } from './key-encryption';
import type { KeyConfig } from './types';

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
 * Check if a key has exceeded rate limits
 */
async function isKeyRateLimited(key: IProviderKey, tokens: number = 0): Promise<boolean> {
  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60000);
  const oneDayAgo = new Date(now - 86400000);

  // Check requests per minute (RPM)
  if (key.rateLimit.rpm) {
    const recentRequests = await ApiUsage.countDocuments({
      keyId: key._id,
      timestamp: { $gte: oneMinuteAgo },
    });

    if (recentRequests >= key.rateLimit.rpm) {
      return true;
    }
  }

  // Check requests per day (RPD)
  if (key.rateLimit.rpd) {
    const dailyRequests = await ApiUsage.countDocuments({
      keyId: key._id,
      timestamp: { $gte: oneDayAgo },
    });

    if (dailyRequests >= key.rateLimit.rpd) {
      return true;
    }
  }

  // Check tokens per minute (TPM)
  if (key.rateLimit.tpm && tokens > 0) {
    const recentTokens = await ApiUsage.aggregate([
      {
        $match: {
          keyId: key._id,
          timestamp: { $gte: oneMinuteAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$tokens' },
        },
      },
    ]);

    const tokenCount = recentTokens[0]?.totalTokens || 0;
    if (tokenCount + tokens > key.rateLimit.tpm) {
      return true;
    }
  }

  // Check tokens per day (TPD)
  if (key.rateLimit.tpd && tokens > 0) {
    const dailyTokens = await ApiUsage.aggregate([
      {
        $match: {
          keyId: key._id,
          timestamp: { $gte: oneDayAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: '$tokens' },
        },
      },
    ]);

    const tokenCount = dailyTokens[0]?.totalTokens || 0;
    if (tokenCount + tokens > key.rateLimit.tpd) {
      return true;
    }
  }

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
    console.warn(`No keys found for provider: ${provider}`);
    return null;
  }

  // Try keys in order of currentPriority (already sorted)
  // Failed keys will have been moved to end of queue
  for (const key of keys) {
    // Check rate limits
    const isLimited = await isKeyRateLimited(key, estimatedTokens);
    if (isLimited) {
      continue;
    }

    // Decrypt the actual API key
    if (!key.encryptedKey) {
      console.warn(`[KeyManager] Key ${key.keyPrefix} (${key.provider}) has no encryptedKey, skipping`);
      continue;
    }

    let decryptedKey: string;
    try {
      decryptedKey = decryptKey(key.encryptedKey);
    } catch (err: any) {
      console.error(`[KeyManager] Failed to decrypt key ${key.keyPrefix} (${key.provider}):`, err.message);
      continue;
    }

    // Found a suitable key
    return {
      keyId: key._id.toString(),
      provider: key.provider,
      modelId,
      key: decryptedKey,
      isPaid: key.isPaid,
      rpm: key.rateLimit.rpm,
      rpd: key.rateLimit.rpd,
      tpm: key.rateLimit.tpm,
      tpd: key.rateLimit.tpd,
    };
  }

  console.warn(`All keys rate-limited for provider: ${provider}`);
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
  }).catch((err) => console.error('Failed to update key stats:', err));
}

/**
 * Record key success (resets failure counters, restores original priority)
 */
export async function recordKeySuccess(keyId: string): Promise<void> {
  try {
    const key = await ProviderKey.findById(keyId);
    if (key) {
      await key.recordSuccess();
      // Invalidate cache to pick up priority changes
      invalidateKeyCache(key.provider);
    }
  } catch (error: any) {
    console.error('Failed to record key success:', error);
  }
}

/**
 * Record key failure (moves key to last priority within its group - free or paid)
 */
export async function recordKeyFailure(keyId: string, reason: string): Promise<void> {
  try {
    const key = await ProviderKey.findById(keyId);
    if (!key) {
      console.warn(`Key not found: ${keyId}`);
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

    // Invalidate cache to pick up priority changes
    invalidateKeyCache(key.provider);
  } catch (error: any) {
    console.error('Failed to record key failure:', error);
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
 * Invalidate key cache (call after adding/removing/modifying keys)
 */
export function invalidateKeyCache(provider?: string): void {
  if (provider) {
    keyCache.delete(`provider:${provider}`);
  } else {
    keyCache.clear();
  }
}
