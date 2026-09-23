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

interface LimitCheckResult {
  allowed: boolean;
  limitType?: 'rpm';
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

    return { allowed: true };
  } catch (err) {
    log.rateLimit.error({ err }, 'Redis rate limit check failed, allowing request');
    return { allowed: true }; // Fail-open
  }
}
