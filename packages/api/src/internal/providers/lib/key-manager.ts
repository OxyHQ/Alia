/**
 * Key Manager - Handles provider key loading, selection, and rate limiting
 * Uses dynamic priority rotation: failed keys move to end of queue
 *
 * The statements live in `db/providers/providerKeyRepository.ts` and
 * `db/telemetry/apiUsageRepository.ts`. The Mongoose instance methods this
 * module used to call (`key.recordSuccess()`, `key.recordFailure()`) are gone;
 * each is now one atomic statement, which is why the read-then-write pairs below
 * have collapsed.
 */

import {
  loadActiveProviderKeys,
  findProviderKeyById,
  markKeyCreditExhausted as markCreditExhausted,
  maxPriorityInGroup,
  providerKeyStats,
  providersWithUsableKeys,
  recordKeyFailure as recordFailureRow,
  recordKeySpend as recordSpendRow,
  recordKeySuccess as recordSuccessRow,
  recordKeyUsage as recordUsageRow,
  renewExpiredKeyQuotas,
  setKeyCooldown,
  type ProviderKeyRow,
  type ProviderKeyStats,
} from '../../../db/providers/providerKeyRepository.js';
import { keyUsageWindows, recordApiUsage } from '../../../db/telemetry/apiUsageRepository.js';
import { getDb } from '../../../db/index.js';
import type { KeyConfig } from './types';
import { log } from '../../../lib/logger.js';

// Pre-compiled patterns for error classification in recordKeyFailure
const TIMEOUT_PATTERN = /timeout|AbortError/i;
const RATE_LIMIT_PATTERN = /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i;

// Cache for loaded keys (TTL: 10 seconds — short to minimize stale-key window)
const keyCache = new Map<string, { keys: ProviderKeyRow[]; timestamp: number }>();
const KEY_CACHE_TTL = 10000;

/**
 * Load all available keys for a provider.
 * Keys are sorted by: 1) Free first, then paid 2) currentPriority within each group
 *
 * That ordering was three JavaScript passes — two filters, two sorts and a
 * concatenation. It is one `ORDER BY` in the repository now, where the index is.
 */
export async function loadProviderKeys(provider: string): Promise<ProviderKeyRow[]> {
  const cacheKey = `provider:${provider}`;
  const cached = keyCache.get(cacheKey);

  // Return cached if still valid
  if (cached && Date.now() - cached.timestamp < KEY_CACHE_TTL) {
    return cached.keys;
  }

  /**
   * A key whose credit period has rolled over gets its spend back BEFORE the
   * rows are read, so the renewed key is in the very load that follows.
   *
   * On the cache miss rather than on every call: at a 10-second TTL this is at
   * most six statements a minute per provider, and the statement matches
   * nothing unless a period has actually expired — every key that predates
   * `credit_renews` carries `never` and is excluded before any date arithmetic.
   *
   * A failure here must not cost the request its keys: the worst case is a
   * renewable key staying retired until the next load, which is the behaviour
   * that existed before this line.
   */
  const renewed = await renewExpiredKeyQuotas(getDb()).catch((err: unknown) => {
    log.keys.warn({ err, provider }, 'Credit-period renewal failed');
    return 0;
  });
  if (renewed > 0) log.keys.info({ provider, renewed }, 'Renewed credit period for keys');

  const keys = await loadActiveProviderKeys(getDb(), provider);
  keyCache.set(cacheKey, { keys, timestamp: Date.now() });
  return keys;
}

/**
 * Check if a key has exceeded rate limits.
 *
 * One statement covering all four windows, where the source built a `$facet`
 * whose branches were added only for the limits a key configured. The
 * "only compute what is configured" optimisation is gone on purpose: the four
 * `FILTER`s run over rows already scanned for the day window, and a branchless
 * version cannot pair a limit with the wrong window.
 */
async function isKeyRateLimited(key: ProviderKeyRow, tokens: number = 0): Promise<boolean> {
  const {
    rateLimitRps: rps, rateLimitRpm: rpm, rateLimitRph: rph, rateLimitRpd: rpd,
    rateLimitTps: tps, rateLimitTpm: tpm, rateLimitTph: tph, rateLimitTpd: tpd,
  } = key;

  // No limits configured = not rate limited
  if (!rps && !rpm && !rph && !rpd && !tps && !tpm && !tph && !tpd) {
    return false;
  }

  const { second, minute, hour, day } = await keyUsageWindows(getDb(), key.id, new Date());

  if (rps && second.count >= rps) return true;
  if (rpm && minute.count >= rpm) return true;
  if (rph && hour.count >= rph) return true;
  if (rpd && day.count >= rpd) return true;
  if (tps && tokens > 0 && second.tokens + tokens > tps) return true;
  if (tpm && tokens > 0 && minute.tokens + tokens > tpm) return true;
  if (tph && tokens > 0 && hour.tokens + tokens > tph) return true;
  if (tpd && tokens > 0 && day.tokens + tokens > tpd) return true;

  return false;
}

/**
 * Get the best available key for a provider/model combination
 * Keys are already sorted by currentPriority (dynamic rotation)
 */
export async function getBestKeyForModel(
  provider: string,
  modelId: string,
  estimatedTokens: number = 0,
  skipKeyIds?: Set<string>,
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
    // Skip keys the caller has already tried and failed on
    if (skipKeyIds?.has(key.id)) {
      continue;
    }

    // Skip keys in cooldown period
    if (key.cooldownUntil && key.cooldownUntil > now) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownUntil: key.cooldownUntil }, 'Key in cooldown, skipping');
      continue;
    }

    // Skip keys whose credential has EXPIRED. Null means NO EXPIRY, never
    // "expired at the epoch" — nothing writes this column, so nearly every row
    // is null and getting that wrong empties the pool.
    //
    // Here rather than in `loadActiveProviderKeys` for two reasons: it is
    // `now`-relative runtime state like its two neighbours, and a row filtered
    // out in SQL cannot be logged as skipped. `warn` rather than their `debug`
    // because a cooldown clears itself and an expiry needs a person.
    if (key.expiresAt && key.expiresAt <= now) {
      log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider, expiresAt: key.expiresAt }, 'Key past expires_at, skipping');
      continue;
    }

    // Skip keys that have exceeded their credit limit. Null means UNLIMITED.
    if (key.creditLimitUsd != null && key.spentUsd >= key.creditLimitUsd) {
      log.keys.debug({ keyPrefix: key.keyPrefix, provider: key.provider, spentUSD: key.spentUsd, creditLimitUSD: key.creditLimitUsd }, 'Key credit exhausted, skipping');
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
      keyId: key.id,
      provider: key.provider,
      modelId,
      key: key.key,
      isPaid: key.isPaid,
      rps: key.rateLimitRps ?? undefined,
      rpm: key.rateLimitRpm ?? undefined,
      rph: key.rateLimitRph ?? undefined,
      rpd: key.rateLimitRpd ?? undefined,
      tps: key.rateLimitTps ?? undefined,
      tpm: key.rateLimitTpm ?? undefined,
      tph: key.rateLimitTph ?? undefined,
      tpd: key.rateLimitTpd ?? undefined,
    };
  }

  // Names every reason the loop above can exhaust the pool, not two of them.
  // The old message said "rate-limited or in cooldown", which sent whoever read
  // it looking at rate limits when the cause was an exhausted credit limit, a
  // key with no stored value, or now an expired one.
  log.keys.warn({ provider }, 'No usable key: all are skipped, expired, rate-limited, in cooldown, credit-exhausted or valueless');
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
  await recordApiUsage(getDb(), { keyId, provider, modelId, tokens, timestamp: new Date() });

  // Update key statistics (fire and forget)
  recordUsageRow(getDb(), keyId, tokens, new Date()).catch((err) =>
    log.keys.error({ err }, 'Failed to update key stats'),
  );
}

/**
 * Record key success (resets failure counters, restores original priority, clears cooldown)
 *
 * One statement where there were three — a read, a `save()` from the Mongoose
 * method, and a second write clearing the cooldown. Between the last two the key
 * looked healthy and was still in cooldown; that window is gone.
 */
export async function recordKeySuccess(keyId: string): Promise<void> {
  try {
    const key = await recordSuccessRow(getDb(), keyId, new Date());
    if (key) {
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
export async function recordKeyFailure(keyId: string, reason: string, retryAfterMs?: number): Promise<void> {
  try {
    const key = await findProviderKeyById(getDb(), keyId);
    if (!key) {
      log.keys.warn({ keyId }, 'Key not found');
      return;
    }

    // Get max priority within the same group (free or paid)
    const maxPriority = (await maxPriorityInGroup(getDb(), key.provider, key.isPaid)) ?? 999;

    // Rate limits are transient — the key works fine, we just hit quota. They
    // move neither failure counter, so they can never archive a key.
    const isRateLimit = RATE_LIMIT_PATTERN.test(reason);
    const outcome = await recordFailureRow(
      getDb(),
      keyId,
      reason,
      maxPriority,
      new Date(),
      isRateLimit,
    );
    if (!outcome) return;

    log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider, priority: outcome.currentPriority, reason: reason.substring(0, 50), isRateLimit }, 'Key moved to last priority after failure');
    if (outcome.archived && !key.isArchived) {
      log.keys.error({ keyPrefix: key.keyPrefix, provider: key.provider, totalFailures: outcome.totalFailures }, 'Key archived after too many failures');
    }

    // Set cooldown.
    // Timeouts indicate slow service, not a bad key — skip cooldown for them.
    // Priority: 1) Provider's Retry-After header, 2) Key's configured rateLimitResetMs, 3) Default
    // For rate_limit errors: use provider Retry-After or key config or 60s flat
    // For other errors: exponential backoff (30s base, doubles per failure, capped at 5min)
    const isTimeout = TIMEOUT_PATTERN.test(reason);
    if (!isTimeout) {
      // The POST-increment count, read back off the write rather than guessed
      // from a value fetched before it — the source added one by hand here
      // because its own method had already incremented.
      const consecutiveFailures = outcome.consecutiveFailures;
      let cooldownMs: number;
      if (retryAfterMs && retryAfterMs > 0) {
        cooldownMs = retryAfterMs; // Provider-supplied Retry-After takes priority
      } else if (isRateLimit && key.rateLimitResetMs) {
        cooldownMs = key.rateLimitResetMs;  // Per-key configured value
      } else if (isRateLimit) {
        cooldownMs = 60000;  // Default 60s for rate limits
      } else {
        cooldownMs = Math.min(30000 * Math.pow(2, Math.max(consecutiveFailures - 1, 0)), 300000);
      }
      const cooldownUntil = new Date(Date.now() + cooldownMs);

      await setKeyCooldown(getDb(), keyId, cooldownUntil);

      log.keys.info({ keyPrefix: key.keyPrefix, provider: key.provider, cooldownSec: cooldownMs / 1000 }, 'Key cooldown set');
    } else {
      log.keys.info({ keyPrefix: key.keyPrefix, provider: key.provider }, 'Timeout failure — skipping cooldown');
    }

    // Invalidate cache to pick up priority changes
    invalidateKeyCache(key.provider);
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Failed to record key failure');
  }
}

/**
 * Get statistics for a provider's keys
 */
export async function getProviderKeyStats(provider: string): Promise<ProviderKeyStats> {
  return providerKeyStats(getDb(), provider);
}

/**
 * Record key spend (fire and forget) - increments spentUSD on the key
 */
export async function recordKeySpend(keyId: string, costUSD: number): Promise<void> {
  if (costUSD <= 0) return;
  recordSpendRow(getDb(), keyId, costUSD).catch((err) =>
    log.keys.error({ err }, 'Failed to update key spend'),
  );
}

/**
 * Mark a key as credit-exhausted (set spentUSD = creditLimitUSD)
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  try {
    // One guarded statement: the source read the key, checked the limit was set
    // and then wrote. A key with no limit is simply not matched.
    const marked = await markCreditExhausted(getDb(), keyId);
    if (!marked) return;

    const key = await findProviderKeyById(getDb(), keyId);
    if (key) {
      invalidateKeyCache(key.provider);
      log.keys.warn({ keyPrefix: key.keyPrefix, provider: key.provider, creditLimitUSD: key.creditLimitUsd }, 'Key marked as credit exhausted');
    }
  } catch (err) {
    log.keys.error({ err }, 'Failed to mark key as credit exhausted');
  }
}

/**
 * Which providers this deployment could actually call, by name.
 *
 * ## Why it is here and not read straight from the repository
 *
 * Two frozen gates decide this file's location, not taste. `architectureGates`
 * gate 4 lets only the provider tree and the credential one-shot import
 * `providerKeyRepository` — a product module that could import it could hold a
 * row — and gate 1 lets only `lib/gateway-client.ts` import the provider tree.
 * So the one legal path from a route to this fact is route → gateway-client →
 * here → repository, and each hop narrows what travels: a row becomes a list of
 * NAMES here, and names become a COUNT in the route.
 *
 * ## A Set, because every caller asks about membership
 *
 * The repository answers with the list Postgres returns. Nothing wants to
 * iterate it; the question is always "is this provider in it", asked once per
 * `provider_health` row.
 *
 * Uncached on purpose, unlike {@link loadProviderKeys} above. That cache exists
 * because the selection path runs per request; this runs behind `/health`'s own
 * ten-second snapshot cache, and a second TTL underneath it would only make the
 * age of the answer harder to reason about.
 */
export async function providersWithUsableCredentials(): Promise<Set<string>> {
  return new Set(await providersWithUsableKeys(getDb(), new Date()));
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
