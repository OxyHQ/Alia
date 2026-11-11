/**
 * Sliding Window Rate Limiter (Redis-backed)
 *
 * One Lua script runs the whole check (trim, count, admit) so concurrent
 * requests on any instance cannot undercount: Redis executes it atomically.
 * A refused request is never recorded, so there is nothing to roll back.
 *
 * When Redis is missing, slow or throwing, each caller chooses, explicitly,
 * what happens (`onUnavailable`):
 *  - `'open'`  allow the request. For authenticated, already-bounded routes
 *              where the hard control lives elsewhere (credits, Postgres).
 *  - `'local'` count in a bounded per-process window instead. For public or
 *              unauthenticated routes: the limit degrades to per-instance
 *              rather than disappearing during a Redis outage.
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

const WINDOW_MS = 60_000;
/** Cap on distinct keys held by the local fallback, so it cannot grow unbounded. */
const LOCAL_MAX_KEYS = 10_000;

interface LimitCheckResult {
  allowed: boolean;
  limitType?: 'rpm';
  current?: number;
  limit?: number;
  resetInSeconds?: number;
}

export interface WindowLimitOptions {
  /** What to do when Redis cannot answer. See the file header. */
  onUnavailable: 'open' | 'local';
}

/**
 * KEYS[1] window key; ARGV: now (ms), window (ms), limit, unique member.
 * Returns {allowed (1|0), count before this request, oldest score in window}.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, tonumber(oldest[2]) or now}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window * 2)
return {1, count, now}
`;

const localWindows = new Map<string, number[]>();

function checkLocalWindow(key: string, limit: number, now: number): LimitCheckResult {
  const recent = (localWindows.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= limit) {
    localWindows.set(key, recent);
    return denied(recent.length, limit, recent[0] ?? now, now);
  }
  if (!localWindows.has(key) && localWindows.size >= LOCAL_MAX_KEYS) {
    for (const [k, times] of localWindows) {
      if ((times[times.length - 1] ?? 0) <= now - WINDOW_MS) localWindows.delete(k);
    }
    // Still full of live keys: drop the oldest-inserted one rather than grow.
    if (localWindows.size >= LOCAL_MAX_KEYS) {
      const first = localWindows.keys().next();
      if (!first.done) localWindows.delete(first.value);
    }
  }
  recent.push(now);
  localWindows.set(key, recent);
  return { allowed: true };
}

function denied(current: number, limit: number, oldestTs: number, now: number): LimitCheckResult {
  return {
    allowed: false,
    limitType: 'rpm',
    current,
    limit,
    resetInSeconds: Math.max(Math.ceil((oldestTs + WINDOW_MS - now) / 1000), 1),
  };
}

/** Test seam: forget the local fallback's state. */
export function resetLocalWindows(): void {
  localWindows.clear();
}

/**
 * Check if a request should be allowed under the sliding window. Per-person
 * `/v1` limit: fails open on a Redis outage because the credit reservation,
 * not this limiter, is the spend ceiling.
 */
export async function checkLimit(userId: string, tier: string): Promise<LimitCheckResult> {
  const rpmLimit = RPM_LIMITS[tier] ?? RPM_LIMITS.free;
  if (rpmLimit <= 0) return { allowed: true }; // Unlimited tier
  return checkWindowLimit(`rl:user:${userId}:rpm`, rpmLimit, { onUnavailable: 'open' });
}

/**
 * The same one-minute sliding window, for any key: what a route with no
 * account to key on (a public share link) limits by.
 */
export async function checkWindowLimit(
  key: string,
  rpmLimit: number,
  options: WindowLimitOptions,
): Promise<LimitCheckResult> {
  const now = Date.now();
  const unavailable = (): LimitCheckResult =>
    options.onUnavailable === 'local' ? checkLocalWindow(key, rpmLimit, now) : { allowed: true };

  const redis = getRedisClient();
  if (!redis) return unavailable();

  try {
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const reply = (await withTimeout(
      redis.eval(SLIDING_WINDOW_SCRIPT, 1, key, now, WINDOW_MS, rpmLimit, member) as Promise<
        [number, number, number]
      >,
    )) as [number, number, number];
    const [allowed, count, oldestTs] = reply;
    if (allowed === 1) return { allowed: true };
    return denied(Number(count), rpmLimit, Number(oldestTs), now);
  } catch (err) {
    log.rateLimit.error(
      { err, onUnavailable: options.onUnavailable },
      'Redis rate limit check failed',
    );
    return unavailable();
  }
}
