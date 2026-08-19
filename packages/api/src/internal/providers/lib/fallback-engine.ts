/**
 * Fallback Engine
 *
 * Sophisticated fallback orchestrator that replaces the simple loop
 * in model-resolver.ts with smart retry logic based on error classification.
 *
 * Retry strategies by FailoverReason:
 * - timeout              -> retry same provider once, then next
 * - rate_limit           -> try next key (up to 3), then next provider
 * - billing              -> skip provider entirely, mark key credit-exhausted
 * - auth                 -> try next key (up to 3), then next provider
 * - provider_unavailable -> skip provider entirely (geo/regional/service-down)
 * - format               -> do NOT retry (would fail again)
 * - content_filter       -> do NOT retry
 * - unknown              -> try next key (up to 3), then next provider
 *
 * Records FallbackEvents asynchronously for analytics (fire-and-forget).
 *
 * ## Which candidates the engine is allowed to walk (ADR 0003 invariant 3)
 *
 * The retry strategies above decide WHEN to move on. The request's
 * `FallbackPolicy` decides WHAT it may move on to, and it is applied once, up
 * front, by narrowing the candidate list before the loop starts. Narrowing the
 * INPUT rather than adding a guard to each of the eight branches above is the
 * whole reason the policy is expressible without touching the retry logic: a
 * branch that cannot see a forbidden candidate cannot select one, so a future
 * ninth branch inherits the policy for free.
 *
 * The default is `cross-model`, which selects every candidate — byte-for-byte
 * the list this engine has always walked.
 */

import type { FailoverReason } from '../../../lib/errors/error-codes';
import type { ResolvedModel } from './model-resolver';
import type { AliaModel, ModelMapping } from './alia-models';
import {
  ALIA_MODELS,
  TIER_MODEL_MAPPINGS,
  isAliaModel,
  getAliaModel,
} from './alia-models';
import {
  DEFAULT_FALLBACK_POLICY,
  FallbackNotPermittedError,
  ROUTING_POLICY_VERSION,
  UnregisteredModelError,
  type FallbackPolicy,
} from '../../../lib/routing/policy.js';
import { getRoutingPreset } from '../../../lib/routing/presets.js';
import { getBestKeyForModel, markKeyCreditExhausted } from './key-manager';
import { isProviderAvailable } from './provider-health';
import { recordFallbackEvent as recordFallbackEventRow } from '../../../db/telemetry/fallbackEventRepository.js';
import { getDb } from '../../../db/index.js';
import { getErrorMessage } from '../../../lib/errors/index.js';
import { log } from '../../../lib/logger.js';

// ============== TYPES ==============

export interface FallbackAttempt {
  provider: string;
  model: string;
  error: string;
  reason: FailoverReason;
  latencyMs: number;
}

export interface FallbackResult {
  resolved: ResolvedModel | null;
  attempts: FallbackAttempt[];
  totalAttempts: number;
  usedFallback: boolean;
  /** The policy this request was resolved under. */
  policy: FallbackPolicy;
  /** The routing-policy configuration version that produced `policy`. */
  policyVersion: number;
}

/** Per-request routing options. Absent means today's behaviour, unchanged. */
export interface FallbackOptions {
  fallbackPolicy?: FallbackPolicy;
}

// Reasons that should NOT be retried at all
const NON_RETRYABLE_REASONS: Set<FailoverReason> = new Set([
  'format',
  'content_filter',
]);

/**
 * The candidates a policy permits, from the tier's priority-sorted list.
 *
 * - `cross-model` returns the list unchanged. Every other branch is opt-in.
 * - `no-fallback` returns the single top-ranked candidate. Key rotation and the
 *   timeout retry still apply to it: those change the credential, not the
 *   model, and ADR 0003's invariant is about model identity.
 * - `same-model-only` returns every candidate serving the SAME upstream model
 *   id as the top-ranked one — ADR 0003 invariant 4's deployment fallback,
 *   which changes nothing a caller can observe about model identity.
 *
 * ## `same-model-only` compares IDENTITY, not the operator's id
 *
 * It used to compare `mapping.modelId`, and this comment used to say that was
 * all the repository stored — that two providers serving one open-weight model
 * can name it differently, so a legitimate same-model deployment was excluded,
 * and that recovering those cases needed a publisher-attributed catalogue.
 *
 * The catalogue now exists. Every mapping carries `publisher` and `model`
 * (`model-publishers.ts`, and the authored names beside each call in
 * `generate-model-mappings.ts`), so sameness is decided on the identity ADR
 * 0003 defines rather than on what an operator happens to call its deployment.
 *
 * The case this recovers is not hypothetical: Meta's Llama 3.3 70B is served
 * under SIX different ids, so a caller pinned to it previously got one
 * deployment where six were eligible — the policy silently refused five
 * legitimate ones and reported exhaustion.
 *
 * The safe direction is unchanged. Admitting a DIFFERENT model is still the
 * error the policy exists to prevent, and the identity pair cannot make it:
 * two rows agree only when both halves agree, and the names are authored so
 * that anything uncertain stays distinct.
 */
function candidatesUnderPolicy(
  sortedMappings: readonly ModelMapping[],
  policy: FallbackPolicy,
): ModelMapping[] {
  if (policy === 'cross-model' || sortedMappings.length === 0) return [...sortedMappings];
  if (policy === 'no-fallback') return [sortedMappings[0]];
  const top = sortedMappings[0];
  return sortedMappings.filter((m) => m.publisher === top.publisher && m.model === top.model);
}

// ============== FALLBACK ENGINE ==============

/**
 * Resolve an Alia model with smart fallback logic.
 *
 * Iterates through tier model mappings in priority order, applying
 * reason-specific retry strategies when resolution fails.
 *
 * @param aliasModelId - The Alia model ID requested
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Providers to skip entirely (from caller)
 * @param callerSkipKeyIds - Specific key IDs to skip (from caller's previous failures)
 * @param options - Per-request routing options; omitted means today's behaviour
 * @returns FallbackResult with the resolved model and attempt history
 * @throws UnregisteredModelError when `aliasModelId` names no registered model
 * @throws FallbackNotPermittedError when a non-default policy exhausts its candidates
 */
export async function resolveWithFallback(
  aliasModelId: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  callerSkipKeyIds: Set<string> = new Set(),
  options: FallbackOptions = {},
): Promise<FallbackResult> {
  const startTime = Date.now();
  const attempts: FallbackAttempt[] = [];

  /**
   * The policy this request resolves under: the CALLER's choice, else the
   * PRODUCT's for the profile being selected, else the default.
   *
   * `lib/routing/presets.ts` describes `fallbackPolicy` as *"enforced by the
   * fallback engine on every request that selects this preset"*, and until this
   * line existed nothing read it — `getRoutingPreset` had no caller outside
   * tests, so the product half of "fallback is an explicit product or user
   * policy" was a table with no consumer. A mechanism can be green and inert;
   * this is the entrypoint that makes it neither.
   *
   * Nothing changes today: every preset carries `DEFAULT_FALLBACK_POLICY`, so
   * the middle term always yields the same value the last one would have. What
   * changes is that narrowing a profile in that table now narrows requests,
   * which is the point of it being configuration.
   *
   * Order matters and is the only ordering that is safe in both directions. A
   * caller who asked for `no-fallback` gets it even where the product allows
   * more, and a caller who asked for nothing inherits whatever the product
   * decided rather than silently the widest thing available.
   */
  const policy = options.fallbackPolicy ?? getRoutingPreset(aliasModelId)?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY;

  /**
   * An identifier nobody registered is refused, not rewritten.
   *
   * This line used to read `isAliaModel(aliasModelId) ? aliasModelId : 'alia-v1'`,
   * so a request naming anything at all was answered from `alia-v1` while every
   * response field, every log line and every analytics row reported the name the
   * caller sent. ADR 0003 invariant 2 forbids that, and ADR 0003's own
   * "alternatives considered" is explicit that an optional disclosure event is
   * not consent for it either.
   *
   * Throwing rather than returning `null` is deliberate. `null` is this
   * function's word for "no provider key was available", which every caller
   * turns into a 503 and a retry — the wrong answer to a request that can never
   * succeed, and indistinguishable from an infrastructure failure.
   */
  if (!isAliaModel(aliasModelId)) {
    log.fallback.warn({ modelId: aliasModelId }, 'Refused unregistered model identifier');
    throw new UnregisteredModelError(aliasModelId, Object.keys(ALIA_MODELS));
  }

  const aliaModel = getAliaModel(aliasModelId);

  if (!aliaModel) {
    log.fallback.error({ modelId: aliasModelId }, 'Failed to get model config');
    recordFallbackEvent(aliasModelId, attempts, null, null, false, Date.now() - startTime, policy);
    return { resolved: null, attempts, totalAttempts: 0, usedFallback: false, policy, policyVersion: ROUTING_POLICY_VERSION };
  }

  const mappings = TIER_MODEL_MAPPINGS[aliaModel.tier];
  if (!mappings || mappings.length === 0) {
    log.fallback.error({ tier: aliaModel.tier }, 'No mappings for tier');
    recordFallbackEvent(aliasModelId, attempts, null, null, false, Date.now() - startTime, policy);
    return { resolved: null, attempts, totalAttempts: 0, usedFallback: false, policy, policyVersion: ROUTING_POLICY_VERSION };
  }

  // Sort by priority (lower = higher priority), then narrow to what the
  // request's policy permits. Under the default this is the same list.
  const sortedMappings = candidatesUnderPolicy(
    [...mappings].sort((a, b) => a.priority - b.priority),
    policy,
  );

  // Track providers to skip for this request (billing issues = skip all keys)
  const requestSkipProviders = new Set(skipProviders);
  // Track specific keys to skip (auth/rate-limit issues = skip that key, try others)
  const skipKeyIds = new Set<string>(callerSkipKeyIds);
  // Track if we already retried a timeout on a given provider/model
  const timeoutRetried = new Set<string>();
  // Track key retries per provider to cap unbounded key cycling
  const MAX_KEYS_PER_PROVIDER = 3;
  const keyRetriesPerProvider = new Map<string, number>();

  for (let i = 0; i < sortedMappings.length; i++) {
    const mapping = sortedMappings[i];

    // Skip providers that the caller or billing failures have excluded
    if (requestSkipProviders.has(mapping.provider)) {
      log.fallback.debug({ provider: mapping.provider }, 'Skipping provider (in skip list)');
      continue;
    }

    // Check provider health (circuit breaker)
    const isAvailable = await isProviderAvailable(mapping.provider, mapping.modelId);
    if (!isAvailable) {
      log.fallback.warn({ provider: mapping.provider, modelId: mapping.modelId }, 'Skipping provider - circuit breaker open');
      attempts.push({
        provider: mapping.provider,
        model: mapping.modelId,
        error: 'Circuit breaker open',
        reason: 'unknown',
        latencyMs: 0,
      });
      continue;
    }

    // Try to get a key for this provider/model
    const result = await tryResolveWithKey(
      mapping,
      aliaModel,
      aliasModelId,
      tokens,
      i,
      skipKeyIds,
    );

    if (result.resolved) {
      // Success
      const usedFallback = i > 0 || attempts.length > 0;
      if (usedFallback) {
        log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId, attempt: attempts.length + 1, policy, policyVersion: ROUTING_POLICY_VERSION }, 'Resolved via fallback');
      } else {
        log.fallback.info({ aliasModelId, provider: mapping.provider, modelId: mapping.modelId, policy, policyVersion: ROUTING_POLICY_VERSION }, 'Resolved model');
      }

      recordFallbackEvent(
        aliasModelId,
        attempts,
        mapping.provider,
        mapping.modelId,
        true,
        Date.now() - startTime,
        policy,
      );

      return {
        resolved: result.resolved,
        attempts,
        totalAttempts: attempts.length,
        usedFallback,
        policy,
        policyVersion: ROUTING_POLICY_VERSION,
      };
    }

    if (result.attempt) {
      attempts.push(result.attempt);

      // Apply reason-specific retry logic
      const reason = result.attempt.reason;

      // Non-retryable reasons: stop trying entirely
      if (NON_RETRYABLE_REASONS.has(reason)) {
        log.fallback.warn({ reason }, 'Non-retryable error, stopping fallback chain');
        break;
      }

      switch (reason) {
        case 'timeout': {
          // Retry same provider once, then move to next
          const retryKey = `${mapping.provider}:${mapping.modelId}`;
          if (!timeoutRetried.has(retryKey)) {
            timeoutRetried.add(retryKey);
            log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Timeout, retrying once');
            i--;
            continue;
          }
          log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Timeout retry exhausted, moving to next');
          break;
        }

        case 'rate_limit': {
          // Try next key for same provider before skipping entirely
          if (result.failedKeyId) {
            const retries = keyRetriesPerProvider.get(mapping.provider) || 0;
            if (retries < MAX_KEYS_PER_PROVIDER) {
              skipKeyIds.add(result.failedKeyId);
              keyRetriesPerProvider.set(mapping.provider, retries + 1);
              log.fallback.info({ provider: mapping.provider, retries: retries + 1 }, 'Rate limited key, trying next key');
              i--;
              continue;
            }
          }
          log.fallback.info({ provider: mapping.provider }, 'Rate limited (all keys tried), skipping to next provider');
          break;
        }

        case 'billing': {
          // Skip this provider entirely for the rest of this request
          requestSkipProviders.add(mapping.provider);
          log.fallback.info({ provider: mapping.provider }, 'Billing issue, skipping provider for this request');
          if (result.failedKeyId) {
            markKeyCreditExhausted(result.failedKeyId).catch(() => {});
          }
          break;
        }

        case 'auth': {
          // Skip that specific key, try next key for same provider
          if (result.failedKeyId) {
            const retries = keyRetriesPerProvider.get(mapping.provider) || 0;
            if (retries < MAX_KEYS_PER_PROVIDER) {
              skipKeyIds.add(result.failedKeyId);
              keyRetriesPerProvider.set(mapping.provider, retries + 1);
              log.fallback.info({ provider: mapping.provider, retries: retries + 1 }, 'Auth issue on key, trying next key');
              i--;
              continue;
            }
          }
          break;
        }

        case 'provider_unavailable': {
          // Provider-level issue (geo-restriction, service down) — skip entirely
          requestSkipProviders.add(mapping.provider);
          log.fallback.info({ provider: mapping.provider }, 'Provider unavailable (geo/regional), skipping');
          break;
        }

        default: {
          // 'unknown' - try next key first, then next provider
          if (result.failedKeyId) {
            const retries = keyRetriesPerProvider.get(mapping.provider) || 0;
            if (retries < MAX_KEYS_PER_PROVIDER) {
              skipKeyIds.add(result.failedKeyId);
              keyRetriesPerProvider.set(mapping.provider, retries + 1);
              log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId, retries: retries + 1 }, 'Unknown error, trying next key');
              i--;
              continue;
            }
          }
          log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Unknown error, trying next provider');
          break;
        }
      }
    }
  }

  // All permitted candidates exhausted
  log.fallback.warn({ modelId: aliasModelId, tier: aliaModel.tier, policy, policyVersion: ROUTING_POLICY_VERSION }, 'All providers exhausted');

  recordFallbackEvent(
    aliasModelId,
    attempts,
    null,
    null,
    false,
    Date.now() - startTime,
    policy,
  );

  /**
   * Under a restrictive policy, exhaustion is a product-level refusal rather
   * than an infrastructure shortage, so it says so (workstream 14: "surface a
   * clear product message when a selected concrete model is unavailable and
   * fallback is not allowed").
   *
   * The branch is keyed on the POLICY, not on whether narrowing actually
   * removed anything. A tier with a single candidate would otherwise report
   * "no fallback was permitted" and "everything failed" differently on days
   * when the ranking happened to be one deep, which is the kind of
   * ranking-dependent message nobody can act on.
   *
   * It is keyed on `'cross-model'` LITERALLY and not on
   * `DEFAULT_FALLBACK_POLICY`. Comparing against the default would make this
   * branch mean "not whatever the default happens to be", so the day somebody
   * flips the default the two arms swap and `cross-model` starts throwing.
   * `cross-model` is the only policy that removes no candidate, which is the
   * actual property being tested. Today it is also the default, which is why
   * every existing caller still gets `null`.
   */
  if (policy !== 'cross-model') {
    throw new FallbackNotPermittedError(aliasModelId, policy);
  }

  return {
    resolved: null,
    attempts,
    totalAttempts: attempts.length,
    usedFallback: attempts.length > 0,
    policy,
    policyVersion: ROUTING_POLICY_VERSION,
  };
}

// ============== INTERNAL HELPERS ==============

interface TryResolveResult {
  resolved: ResolvedModel | null;
  attempt: FallbackAttempt | null;
  failedKeyId: string | null;
}

/**
 * Try to resolve a single mapping to a working key.
 */
async function tryResolveWithKey(
  mapping: ModelMapping,
  aliaModel: AliaModel,
  aliasModelId: string,
  tokens: number,
  fallbackIndex: number,
  skipKeyIds: Set<string>,
): Promise<TryResolveResult> {
  const attemptStart = Date.now();

  try {
    const keyConfig = await getBestKeyForModel(
      mapping.provider,
      mapping.modelId,
      tokens,
      skipKeyIds,
    );

    if (!keyConfig) {
      return {
        resolved: null,
        attempt: {
          provider: mapping.provider,
          model: mapping.modelId,
          error: 'No available keys (all rate-limited, in cooldown, or skipped)',
          reason: 'rate_limit',
          latencyMs: Date.now() - attemptStart,
        },
        failedKeyId: null,
      };
    }

    // Successfully resolved
    const isFallback = fallbackIndex > 0;
    return {
      resolved: {
        aliasModelId,
        provider: mapping.provider,
        modelId: mapping.modelId,
        keyConfig,
        aliaModel,
        isFallback,
        fallbackIndex,
      },
      attempt: null,
      failedKeyId: null,
    };
  } catch (error: unknown) {
    return {
      resolved: null,
      attempt: {
        provider: mapping.provider,
        model: mapping.modelId,
        error: getErrorMessage(error),
        reason: 'unknown',
        latencyMs: Date.now() - attemptStart,
      },
      failedKeyId: null,
    };
  }
}

// ============== ANALYTICS (FIRE-AND-FORGET) ==============

/**
 * Record a fallback event for analytics. Non-blocking, fire-and-forget.
 *
 * `fallbackPolicy` and the routing-policy version travel with the row because
 * this table is where "why did this response come from this model" is answered,
 * and the answer changes when the preset table changes. A row without them can
 * only be read against whatever the configuration says TODAY, which is a
 * different question from the one being asked.
 *
 * The early return is unchanged: a first-try success with no failed attempt
 * still writes nothing. That is the request where nothing diverged and there is
 * no routing decision to explain — and changing it would multiply this table's
 * write volume by every chat in the product, which is a capacity decision and
 * not this workstream's to make.
 */
function recordFallbackEvent(
  aliasModel: string,
  attempts: FallbackAttempt[],
  finalProvider: string | null,
  finalModel: string | null,
  success: boolean,
  totalLatencyMs: number,
  fallbackPolicy: FallbackPolicy,
): void {
  // Only record if there were attempts (avoid recording trivial first-try successes with no failures)
  if (attempts.length === 0 && success) {
    return;
  }

  recordFallbackEventRow(getDb(), {
    timestamp: new Date(),
    aliasModel,
    attempts: attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      error: a.error.substring(0, 500),
      reason: a.reason,
      latencyMs: a.latencyMs,
    })),
    finalProvider,
    finalModel,
    success,
    totalLatencyMs,
    fallbackPolicy,
    routingPolicyVersion: ROUTING_POLICY_VERSION,
  }).catch((err) => {
    log.fallback.error({ err }, 'Failed to record fallback event');
  });
}
