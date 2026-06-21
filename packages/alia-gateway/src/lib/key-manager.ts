/**
 * Key Manager - Handles provider key loading, selection, and rate limiting
 * Uses dynamic priority rotation: failed keys move to end of queue
 *
 * Optimizations:
 * - Batched rate-limit queries: one aggregation per time window for ALL candidate keys
 * - Latency-weighted key selection: keys with lower provider latency score better
 * - Daily/monthly spend caps: rolling-window cost checks from tracked spend fields
 */

import mongoose from 'mongoose';
import { ProviderKey, IProviderKey } from '../models/provider-key.js';
import { ApiUsage } from '../models/api-usage.js';
import { getProviderHealth } from './provider-health.js';
import type { KeyConfig } from './types';
import { log } from './logger';

// Cache for loaded keys (TTL: 30 seconds)
const keyCache = new Map<string, { keys: IProviderKey[]; timestamp: number }>();
const KEY_CACHE_TTL = 30000;

// Rolling window durations in milliseconds
const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

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
    .filter((k: IProviderKey) => !k.isPaid)
    .sort((a: IProviderKey, b: IProviderKey) => a.currentPriority - b.currentPriority);

  const paidKeys = allKeys
    .filter((k: IProviderKey) => k.isPaid)
    .sort((a: IProviderKey, b: IProviderKey) => a.currentPriority - b.currentPriority);

  // Free keys first, then paid keys
  const keys = [...freeKeys, ...paidKeys];

  // Cache the results
  keyCache.set(cacheKey, { keys, timestamp: Date.now() });

  return keys;
}

// ============== BATCHED RATE-LIMIT QUERIES ==============

interface WindowStats {
  count: number;
  tokens: number;
}

/** Per-key usage stats across all time windows, loaded in batch. */
interface BatchedKeyUsage {
  second: WindowStats;
  minute: WindowStats;
  hour: WindowStats;
  day: WindowStats;
}

const EMPTY_STATS: WindowStats = { count: 0, tokens: 0 };

/**
 * Batch-load usage stats for a set of keys across all rate-limit windows.
 *
 * Runs one aggregation per distinct time window (1s, 1m, 1h, 1d) — at most
 * 4 DB round-trips total regardless of how many keys there are, instead of
 * N round-trips (one per key).
 *
 * Returns a Map from key._id.toString() -> BatchedKeyUsage.
 */
async function batchLoadUsageStats(
  keys: IProviderKey[],
): Promise<Map<string, BatchedKeyUsage>> {
  const result = new Map<string, BatchedKeyUsage>();

  if (keys.length === 0) return result;

  // Determine which windows are actually needed based on the keys' rate limits
  let needSecond = false;
  let needMinute = false;
  let needHour = false;
  let needDay = false;

  for (const key of keys) {
    const rl = key.rateLimit;
    if (rl.rps || rl.tps) needSecond = true;
    if (rl.rpm || rl.tpm) needMinute = true;
    if (rl.rph || rl.tph) needHour = true;
    if (rl.rpd || rl.tpd) needDay = true;
  }

  // If no rate limits configured on any key, return empty map (all pass)
  if (!needSecond && !needMinute && !needHour && !needDay) {
    return result;
  }

  const now = Date.now();
  const keyIds = keys.map((k) => k._id);

  // Helper: run one aggregation for a time window, grouped by keyId
  async function aggregateWindow(
    sinceMs: number,
  ): Promise<Map<string, WindowStats>> {
    const since = new Date(now - sinceMs);
    const rows: Array<{ _id: mongoose.Types.ObjectId; count: number; tokens: number }> =
      await ApiUsage.aggregate([
        { $match: { keyId: { $in: keyIds }, timestamp: { $gte: since } } },
        { $group: { _id: '$keyId', count: { $sum: 1 }, tokens: { $sum: '$tokens' } } },
      ]);
    const map = new Map<string, WindowStats>();
    for (const row of rows) {
      map.set(row._id.toString(), { count: row.count, tokens: row.tokens });
    }
    return map;
  }

  // Fire all needed window queries in parallel
  const [secondMap, minuteMap, hourMap, dayMap] = await Promise.all([
    needSecond ? aggregateWindow(ONE_SECOND_MS) : Promise.resolve(new Map<string, WindowStats>()),
    needMinute ? aggregateWindow(ONE_MINUTE_MS) : Promise.resolve(new Map<string, WindowStats>()),
    needHour ? aggregateWindow(ONE_HOUR_MS) : Promise.resolve(new Map<string, WindowStats>()),
    needDay ? aggregateWindow(ONE_DAY_MS) : Promise.resolve(new Map<string, WindowStats>()),
  ]);

  // Assemble per-key results
  for (const key of keys) {
    const id = key._id.toString();
    result.set(id, {
      second: secondMap.get(id) ?? EMPTY_STATS,
      minute: minuteMap.get(id) ?? EMPTY_STATS,
      hour: hourMap.get(id) ?? EMPTY_STATS,
      day: dayMap.get(id) ?? EMPTY_STATS,
    });
  }

  return result;
}

/**
 * Check if a key exceeds its rate limits using pre-loaded batched usage stats.
 */
function isKeyRateLimitedFromBatch(
  key: IProviderKey,
  usage: BatchedKeyUsage,
  estimatedTokens: number,
): boolean {
  const rl = key.rateLimit;

  if (rl.rps && usage.second.count >= rl.rps) return true;
  if (rl.rpm && usage.minute.count >= rl.rpm) return true;
  if (rl.rph && usage.hour.count >= rl.rph) return true;
  if (rl.rpd && usage.day.count >= rl.rpd) return true;

  if (estimatedTokens > 0) {
    if (rl.tps && usage.second.tokens + estimatedTokens > rl.tps) return true;
    if (rl.tpm && usage.minute.tokens + estimatedTokens > rl.tpm) return true;
    if (rl.tph && usage.hour.tokens + estimatedTokens > rl.tph) return true;
    if (rl.tpd && usage.day.tokens + estimatedTokens > rl.tpd) return true;
  }

  return false;
}

// ============== DAILY/MONTHLY SPEND CAP CHECKS ==============

/**
 * Check if a key has exceeded its daily or monthly spend cap.
 *
 * Uses the rolling-window tracked fields on the key document
 * (dailySpentUSD / monthlySpentUSD) which are reset when the
 * window expires. No extra DB query needed.
 */
function isKeyOverSpendCap(key: IProviderKey, nowMs: number): boolean {
  // Daily cap check
  if (key.dailyLimitUSD != null) {
    const windowExpired = nowMs - key.dailySpentResetAt.getTime() >= ONE_DAY_MS;
    const dailySpent = windowExpired ? 0 : key.dailySpentUSD;
    if (dailySpent >= key.dailyLimitUSD) {
      return true;
    }
  }

  // Monthly cap check
  if (key.monthlyLimitUSD != null) {
    const windowExpired = nowMs - key.monthlySpentResetAt.getTime() >= THIRTY_DAYS_MS;
    const monthlySpent = windowExpired ? 0 : key.monthlySpentUSD;
    if (monthlySpent >= key.monthlyLimitUSD) {
      return true;
    }
  }

  return false;
}

// ============== LATENCY-WEIGHTED KEY SCORING ==============

/**
 * Compute an effective score for key selection.
 *
 * Base score is the key's currentPriority (lower = better).
 * A latency penalty of (averageLatencyMs / 1000) is added so that among
 * keys with similar priority, faster providers win.
 *
 * Example: priority 5 + 200ms latency = score 5.2
 *          priority 6 + 50ms latency  = score 6.05
 */
async function computeKeyScore(key: IProviderKey, modelId: string): Promise<number> {
  let latencyPenalty = 0;

  try {
    const health = await getProviderHealth(key.provider, modelId);
    if (health.averageLatencyMs > 0) {
      latencyPenalty = health.averageLatencyMs / 1000;
    }
  } catch {
    // If health data is unavailable, skip the latency adjustment
  }

  return key.currentPriority + latencyPenalty;
}

/**
 * Get the best available key for a provider/model combination.
 *
 * Improvements over the naive per-key loop:
 * 1. Rate limits are checked from a single batched aggregation (not N queries)
 * 2. Daily/monthly spend caps are evaluated from tracked key fields
 * 3. Keys are scored with a latency penalty so faster providers win ties
 */
export async function getBestKeyForModel(
  provider: string,
  modelId: string,
  estimatedTokens: number = 0,
  skipKeyIds?: Set<string>
): Promise<KeyConfig | null> {
  const keys = await loadProviderKeys(provider);

  if (keys.length === 0) {
    log.keys.warn({ provider }, 'No keys found for provider');
    return null;
  }

  const nowMs = Date.now();
  const now = new Date(nowMs);

  // --- Phase 1: Pre-filter candidates (cheap, no DB) ---
  const candidates: IProviderKey[] = [];
  for (const key of keys) {
    if (skipKeyIds?.has(key._id.toString())) continue;

    if (key.cooldownUntil && key.cooldownUntil > now) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownUntil: key.cooldownUntil }, 'Key in cooldown, skipping');
      continue;
    }

    if (key.creditLimitUSD != null && key.spentUSD >= key.creditLimitUSD) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, spentUSD: key.spentUSD, creditLimitUSD: key.creditLimitUSD }, 'Key credit exhausted, skipping');
      continue;
    }

    if (isKeyOverSpendCap(key, nowMs)) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Key over daily/monthly spend cap, skipping');
      continue;
    }

    if (!key.key) {
      log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Key has no value, skipping');
      continue;
    }

    candidates.push(key);
  }

  if (candidates.length === 0) {
    log.keys.warn({ provider }, 'All keys filtered out before rate-limit check');
    return null;
  }

  // --- Phase 2: Batch-load rate-limit usage for all candidates (1-4 DB queries total) ---
  const usageMap = await batchLoadUsageStats(candidates);

  // --- Phase 3: Filter by rate limits, then score with latency ---
  interface ScoredKey {
    key: IProviderKey;
    score: number;
  }

  const scorePromises: Array<Promise<ScoredKey | null>> = [];
  for (const key of candidates) {
    const usage = usageMap.get(key._id.toString());
    const batchedUsage: BatchedKeyUsage = usage ?? {
      second: EMPTY_STATS,
      minute: EMPTY_STATS,
      hour: EMPTY_STATS,
      day: EMPTY_STATS,
    };

    if (isKeyRateLimitedFromBatch(key, batchedUsage, estimatedTokens)) {
      continue;
    }

    // Compute score asynchronously (reads from provider-health cache, no extra DB call)
    scorePromises.push(
      computeKeyScore(key, modelId).then((score) => ({ key, score }))
    );
  }

  const scoredKeys = (await Promise.all(scorePromises)).filter(
    (entry): entry is ScoredKey => entry !== null,
  );

  if (scoredKeys.length === 0) {
    log.keys.warn({ provider }, 'All keys rate-limited or in cooldown');
    return null;
  }

  // Sort by effective score (lower = better); within same isPaid group, free keys first
  scoredKeys.sort((a, b) => {
    // Free keys before paid keys
    if (a.key.isPaid !== b.key.isPaid) {
      return a.key.isPaid ? 1 : -1;
    }
    return a.score - b.score;
  });

  const best = scoredKeys[0].key;
  // best.key is guaranteed defined — candidates without a key value were
  // filtered out in Phase 1 above.
  const keyValue = best.key ?? '';
  return {
    keyId: best._id.toString(),
    provider: best.provider,
    modelId,
    key: keyValue,
    isPaid: best.isPaid,
    rps: best.rateLimit.rps,
    rpm: best.rateLimit.rpm,
    rph: best.rateLimit.rph,
    rpd: best.rateLimit.rpd,
    tps: best.rateLimit.tps,
    tpm: best.rateLimit.tpm,
    tph: best.rateLimit.tph,
    tpd: best.rateLimit.tpd,
  };
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
  }).catch((err: unknown) => log.keys.error({ err }, 'Failed to update key stats'));
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
  } catch (error: unknown) {
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

    // Set cooldown (atomic $set)
    // For rate_limit errors: use key's rateLimitResetMs if configured, else 60s flat (matches most providers' per-minute windows)
    // For other errors: exponential backoff (30s base, doubles per failure, capped at 5min)
    const consecutiveFailures = (key.consecutiveFailures || 0) + 1; // +1 because recordFailure already incremented
    const isRateLimit = /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i.test(reason);
    let cooldownMs: number;
    if (isRateLimit && key.rateLimitResetMs) {
      cooldownMs = key.rateLimitResetMs;  // Per-key configured value
    } else if (isRateLimit) {
      cooldownMs = 60000;  // Default 60s for rate limits
    } else {
      cooldownMs = Math.min(30000 * Math.pow(2, consecutiveFailures - 1), 300000);
    }
    const cooldownUntil = new Date(Date.now() + cooldownMs);

    await ProviderKey.updateOne(
      { _id: keyId },
      { $set: { cooldownUntil } }
    );

    log.keys.info({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownSec: cooldownMs / 1000 }, 'Key cooldown set');

    // Invalidate cache to pick up priority changes
    invalidateKeyCache(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Failed to record key failure');
  }
}

interface ProviderKeyStatsResult {
  total: number;
  active: number;
  rateLimited: number;
  averageSuccessRate: number;
  totalRequests: number;
  totalFailures: number;
}

/**
 * Get statistics for a provider's keys
 */
export async function getProviderKeyStats(provider: string): Promise<ProviderKeyStatsResult> {
  const keys = await ProviderKey.find({ provider, isArchived: false });

  return {
    total: keys.length,
    active: keys.filter((k: IProviderKey) => k.isActive).length,
    rateLimited: 0, // Would need to check actual rate limits
    averageSuccessRate:
      keys.reduce((sum: number, k: IProviderKey) => {
        const total = k.successCount + k.totalFailures;
        return sum + (total > 0 ? k.successCount / total : 1);
      }, 0) / keys.length,
    totalRequests: keys.reduce((sum: number, k: IProviderKey) => sum + k.totalRequests, 0),
    totalFailures: keys.reduce((sum: number, k: IProviderKey) => sum + k.totalFailures, 0),
  };
}

/**
 * Record key spend (fire and forget).
 *
 * Increments spentUSD (lifetime) and the rolling daily/monthly spend trackers.
 * If a rolling window has expired, resets it before incrementing.
 */
export async function recordKeySpend(keyId: string, costUSD: number): Promise<void> {
  if (costUSD <= 0) return;

  const now = Date.now();

  ProviderKey.findById(keyId).then((key) => {
    if (!key) return;

    // Always increment lifetime spend
    key.spentUSD += costUSD;

    // Daily window: reset if expired, then increment
    if (now - key.dailySpentResetAt.getTime() >= ONE_DAY_MS) {
      key.dailySpentUSD = costUSD;
      key.dailySpentResetAt = new Date(now);
    } else {
      key.dailySpentUSD += costUSD;
    }

    // Monthly window: reset if expired, then increment
    if (now - key.monthlySpentResetAt.getTime() >= THIRTY_DAYS_MS) {
      key.monthlySpentUSD = costUSD;
      key.monthlySpentResetAt = new Date(now);
    } else {
      key.monthlySpentUSD += costUSD;
    }

    return key.save();
  }).catch((err: unknown) => log.keys.error({ err }, 'Failed to update key spend'));
}

/**
 * Mark a key as credit-exhausted.
 * If creditLimitUSD is set, marks spent = limit.
 * If no credit limit configured, sets a 1-hour cooldown to prevent retry loops.
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  try {
    const key = await ProviderKey.findById(keyId);
    if (!key) return;

    if (key.creditLimitUSD != null) {
      await ProviderKey.updateOne(
        { _id: keyId },
        { $set: { spentUSD: key.creditLimitUSD } }
      );
    } else {
      // No credit limit configured — set a 1-hour cooldown
      await ProviderKey.updateOne(
        { _id: keyId },
        { $set: { cooldownUntil: new Date(Date.now() + 3600000) } }
      );
    }
    invalidateKeyCache(key.provider);
    log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Key marked as credit exhausted');
  } catch (err) {
    log.keys.error({ err }, 'Failed to mark key as credit exhausted');
  }
}

/**
 * Invalidate key cache (call after adding/removing/modifying keys).
 *
 * Note: The model-resolver has its own short-lived resolve cache (5s TTL).
 * Callers that need immediate invalidation of both caches should also call
 * clearResolveCache() from model-resolver.ts. The short TTL ensures stale
 * entries expire quickly even without explicit clearing.
 */
export function invalidateKeyCache(provider?: string): void {
  if (provider) {
    keyCache.delete(`provider:${provider}`);
  } else {
    keyCache.clear();
  }
}
