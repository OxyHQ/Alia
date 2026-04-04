/**
 * Fallback Engine
 *
 * Sophisticated fallback orchestrator that replaces the simple loop
 * in model-resolver.ts with smart retry logic based on error classification.
 *
 * Retry strategies by FailoverReason:
 * - timeout     -> retry same provider once with shorter timeout, then next
 * - rate_limit  -> skip to next provider immediately
 * - billing     -> skip provider entirely for this request
 * - auth        -> skip that specific key, try next key for same provider
 * - format      -> do NOT retry (would fail again)
 * - content_filter -> do NOT retry
 * - unknown     -> move to next provider
 *
 * Records FallbackEvents asynchronously for analytics (fire-and-forget).
 */

import type { KeyConfig } from './types';
import type { FailoverReason } from './errors/error-codes';
import type { ResolvedModel } from './model-resolver';
import type { ClarityModel, ModelMapping } from './clarity-models';
import {
  TIER_MODEL_MAPPINGS,
  isClarityModel,
  getClarityModel,
} from './clarity-models';
import { getBestKeyForModel, markKeyCreditExhausted } from './key-manager';
import { isProviderAvailable } from './provider-health';
import { FallbackEvent } from '../models/fallback-event.js';
import { log } from './logger';

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
}

// Reasons that should NOT be retried at all
const NON_RETRYABLE_REASONS: Set<FailoverReason> = new Set([
  'format',
  'content_filter',
]);

// ============== FALLBACK ENGINE ==============

/**
 * Resolve an Clarity model with smart fallback logic.
 *
 * Iterates through tier model mappings in priority order, applying
 * reason-specific retry strategies when resolution fails.
 *
 * @param clarityModelId - The Clarity model ID requested
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Providers to skip entirely (from caller)
 * @param callerSkipKeyIds - Specific key IDs to skip (from caller, e.g. keys that already failed)
 * @returns FallbackResult with the resolved model and attempt history
 */
export async function resolveWithFallback(
  clarityModelId: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  callerSkipKeyIds: Set<string> = new Set(),
): Promise<FallbackResult> {
  const startTime = Date.now();
  const attempts: FallbackAttempt[] = [];

  // Normalize model ID
  const normalizedModelId = isClarityModel(clarityModelId) ? clarityModelId : 'clarity-v1';
  const clarityModel = getClarityModel(normalizedModelId);

  if (!clarityModel) {
    log.fallback.error({ modelId: normalizedModelId }, 'Failed to get model config');
    recordFallbackEvent(normalizedModelId, attempts, null, null, false, Date.now() - startTime);
    return { resolved: null, attempts, totalAttempts: 0, usedFallback: false };
  }

  const mappings = TIER_MODEL_MAPPINGS[clarityModel.tier];
  if (!mappings || mappings.length === 0) {
    log.fallback.error({ tier: clarityModel.tier }, 'No mappings for tier');
    recordFallbackEvent(normalizedModelId, attempts, null, null, false, Date.now() - startTime);
    return { resolved: null, attempts, totalAttempts: 0, usedFallback: false };
  }

  // Sort by priority (lower = higher priority)
  const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority);

  // Track providers to skip for this request (billing issues = skip all keys)
  const requestSkipProviders = new Set(skipProviders);
  // Track specific keys to skip — merge caller-provided IDs with local auth failures
  const skipKeyIds = new Set<string>(callerSkipKeyIds);
  // Track if we already retried a timeout on a given provider/model
  const timeoutRetried = new Set<string>();

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
      clarityModel,
      normalizedModelId,
      tokens,
      i,
      skipKeyIds,
    );

    if (result.resolved) {
      // Success
      const usedFallback = i > 0 || attempts.length > 0;
      if (usedFallback) {
        log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId, attempt: attempts.length + 1 }, 'Resolved via fallback');
      } else {
        log.fallback.info({ clarityModelId: normalizedModelId, provider: mapping.provider, modelId: mapping.modelId }, 'Resolved model');
      }

      recordFallbackEvent(
        normalizedModelId,
        attempts,
        mapping.provider,
        mapping.modelId,
        true,
        Date.now() - startTime,
      );

      return {
        resolved: result.resolved,
        attempts,
        totalAttempts: attempts.length,
        usedFallback,
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
            // Retry the same mapping (decrement i so the loop re-tries it)
            i--;
            continue;
          }
          // Already retried, move to next provider
          log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Timeout retry exhausted, moving to next');
          break;
        }

        case 'rate_limit': {
          // Skip to next provider immediately
          log.fallback.info({ provider: mapping.provider }, 'Rate limited, skipping to next provider');
          break;
        }

        case 'billing': {
          // Skip this provider entirely for the rest of this request
          requestSkipProviders.add(mapping.provider);
          log.fallback.info({ provider: mapping.provider }, 'Billing issue, skipping provider for this request');

          // Mark the key as credit exhausted so it won't be selected again
          if (result.failedKeyId) {
            markKeyCreditExhausted(result.failedKeyId).catch(() => {});
          }
          break;
        }

        case 'auth': {
          // Skip that specific key, try next key for same provider
          if (result.failedKeyId) {
            skipKeyIds.add(result.failedKeyId);
            log.fallback.info({ provider: mapping.provider }, 'Auth issue on key, trying next key');
            // Retry same mapping with different key
            i--;
            continue;
          }
          // No key ID available, move to next provider
          break;
        }

        default: {
          // 'unknown' - move to next provider
          log.fallback.info({ provider: mapping.provider, modelId: mapping.modelId }, 'Unknown error, trying next');
          break;
        }
      }
    }
  }

  // All providers exhausted
  log.fallback.warn({ modelId: normalizedModelId, tier: clarityModel.tier }, 'All providers exhausted');

  recordFallbackEvent(
    normalizedModelId,
    attempts,
    null,
    null,
    false,
    Date.now() - startTime,
  );

  return {
    resolved: null,
    attempts,
    totalAttempts: attempts.length,
    usedFallback: attempts.length > 0,
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
  clarityModel: ClarityModel,
  clarityModelId: string,
  tokens: number,
  fallbackIndex: number,
  skipKeyIds: Set<string>,
): Promise<TryResolveResult> {
  const attemptStart = Date.now();

  try {
    // Pass skipKeyIds so the key manager filters them out directly
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
          error: 'No available keys (all rate-limited, skipped, or in cooldown)',
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
        clarityModelId,
        provider: mapping.provider,
        modelId: mapping.modelId,
        keyConfig,
        clarityModel,
        isFallback,
        fallbackIndex,
      },
      attempt: null,
      failedKeyId: null,
    };
  } catch (error: any) {
    return {
      resolved: null,
      attempt: {
        provider: mapping.provider,
        model: mapping.modelId,
        error: error?.message || String(error),
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
 */
function recordFallbackEvent(
  aliasModel: string,
  attempts: FallbackAttempt[],
  finalProvider: string | null,
  finalModel: string | null,
  success: boolean,
  totalLatencyMs: number,
): void {
  // Only record if there were attempts (avoid recording trivial first-try successes with no failures)
  if (attempts.length === 0 && success) {
    return;
  }

  FallbackEvent.create({
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
  }).catch((err: any) => {
    log.fallback.error({ err }, 'Failed to record fallback event');
  });
}
