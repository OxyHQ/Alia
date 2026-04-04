/**
 * Sliding Window Rate Limiter (Redis-backed)
 * Uses Redis sorted sets for distributed rate limiting across multiple instances.
 * Falls back to allowing requests if Redis is unavailable (fail-open).
 */

import { getRedisClient, withRedisTimeout as withTimeout } from './redis.js';
import { log } from './logger.js';

// Requests/minute limits per tier
const RPM_LIMITS: Record<string, number> = {
  free: 20,
  pro: 60,
  pro_plus: 120,
  business: 200,
  enterprise: -1, // unlimited
};

// Cost/day caps per subscription tier (in credits)
// All tiers unlimited — credits are the sole usage gate.
const COST_DAY_CAPS: Record<string, number> = {
  free: -1,
  pro: -1,
  pro_plus: -1,
  business: -1,
  enterprise: -1,
};

export interface LimitCheckResult {
  allowed: boolean;
  limitType?: 'rpm' | 'daily_cost';
  current?: number;
  limit?: number;
  resetInSeconds?: number;
}

/**
 * Check if a request should be allowed under the sliding window.
 * Uses Redis sorted sets for distributed state.
 */
export async function checkLimit(userId: string, tier: string): Promise<LimitCheckResult> {
  const redis = getRedisClient();
  if (!redis) return { allowed: true }; // Fail-open if no Redis

  const rpmLimit = RPM_LIMITS[tier] ?? RPM_LIMITS.free;
  if (rpmLimit <= 0) return { allowed: true }; // Unlimited tier

  const key = `rl:user:${userId}:rpm`;
  const now = Date.now();
  const windowMs = 60_000;
  const windowStart = now - windowMs;

  try {
    const pipeline = redis.pipeline();
    // Remove expired entries
    pipeline.zremrangebyscore(key, 0, windowStart);
    // Count current entries
    pipeline.zcard(key);
    // Add current request (optimistic — will check count after)
    pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
    // Set TTL so keys don't leak
    pipeline.expire(key, 120);

    const results = await withTimeout(pipeline.exec());
    if (!results) return { allowed: true };

    const currentCount = (results[1]?.[1] as number) || 0;

    if (currentCount >= rpmLimit) {
      // Over limit — remove the optimistic add
      const addedMember = results[2];
      if (addedMember) {
        // Remove the last added member
        await redis.zremrangebyscore(key, now, now);
      }

      // Calculate reset time from oldest entry in window
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTs = oldest.length >= 2 ? parseInt(oldest[1]) : now;
      const resetInSeconds = Math.max(Math.ceil((oldestTs + windowMs - now) / 1000), 1);

      return {
        allowed: false,
        limitType: 'rpm',
        current: currentCount,
        limit: rpmLimit,
        resetInSeconds,
      };
    }

    // Check daily cost cap
    const costCap = COST_DAY_CAPS[tier] ?? COST_DAY_CAPS.free;
    if (costCap > 0) {
      const costKey = `rl:user:${userId}:cost`;
      const costStr = await redis.get(costKey);
      const costToday = parseFloat(costStr || '0');

      if (costToday >= costCap) {
        const now_ = new Date();
        const midnight = new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + 1);
        const resetInSeconds = Math.ceil((midnight.getTime() - now_.getTime()) / 1000);
        return {
          allowed: false,
          limitType: 'daily_cost',
          current: costToday,
          limit: costCap,
          resetInSeconds,
        };
      }
    }

    return { allowed: true };
  } catch (err) {
    log.rateLimit.error({ err }, 'Redis rate limit check failed, allowing request');
    return { allowed: true }; // Fail-open
  }
}

/**
 * Increment the daily cost counter for a user.
 * Called from finalizeCredits after a request completes.
 */
export async function incrementDailyCost(userId: string, credits: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const key = `rl:user:${userId}:cost`;
    await redis.incrbyfloat(key, credits);
    // Expire at midnight — set TTL to max 24 hours
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ttl = Math.ceil((midnight.getTime() - now.getTime()) / 1000);
    await redis.expire(key, ttl);
  } catch (err) {
    log.rateLimit.error({ err }, 'Failed to increment daily cost in Redis');
  }
}

/**
 * Get current daily cost for spending alerts.
 */
export async function getDailyCost(userId: string): Promise<{ costToday: number; cap: number }> {
  const redis = getRedisClient();
  if (!redis) return { costToday: 0, cap: 0 };

  try {
    const costStr = await redis.get(`rl:user:${userId}:cost`);
    return { costToday: parseFloat(costStr || '0'), cap: 0 };
  } catch {
    return { costToday: 0, cap: 0 };
  }
}

/**
 * Get the daily cost cap for a tier.
 */
export function getDailyCostCap(tier: string): number {
  return COST_DAY_CAPS[tier] ?? COST_DAY_CAPS.free;
}

/**
 * Check if user is approaching their daily cost cap (>80%).
 */
export async function isApproachingDailyCap(userId: string, tier: string): Promise<boolean> {
  const cap = COST_DAY_CAPS[tier] ?? COST_DAY_CAPS.free;
  if (cap <= 0) return false;

  const { costToday } = await getDailyCost(userId);
  return costToday >= cap * 0.8;
}
