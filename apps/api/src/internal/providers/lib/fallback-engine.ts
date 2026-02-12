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
import type { FailoverReason } from '../../../lib/errors/error-codes';
import type { ResolvedModel } from './model-resolver';
import type { AliaModel, ModelMapping } from './alia-models';
import {
  TIER_MODEL_MAPPINGS,
  isAliaModel,
  getAliaModel,
} from './alia-models';
import { getBestKeyForModel } from './key-manager';
import { isProviderAvailable } from './provider-health';
import { FallbackEvent } from '../models/fallback-event';

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
 * Resolve an Alia model with smart fallback logic.
 *
 * Iterates through tier model mappings in priority order, applying
 * reason-specific retry strategies when resolution fails.
 *
 * @param aliasModelId - The Alia model ID requested
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Providers to skip entirely (from caller)
 * @returns FallbackResult with the resolved model and attempt history
 */
export async function resolveWithFallback(
  aliasModelId: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
): Promise<FallbackResult> {
  const startTime = Date.now();
  const attempts: FallbackAttempt[] = [];

  // Normalize model ID
  const normalizedModelId = isAliaModel(aliasModelId) ? aliasModelId : 'alia-v1';
  const aliaModel = getAliaModel(normalizedModelId);

  if (!aliaModel) {
    console.error(`[FallbackEngine] Failed to get model config for: ${normalizedModelId}`);
    recordFallbackEvent(normalizedModelId, attempts, null, null, false, Date.now() - startTime);
    return { resolved: null, attempts, totalAttempts: 0, usedFallback: false };
  }

  const mappings = TIER_MODEL_MAPPINGS[aliaModel.tier];
  if (!mappings || mappings.length === 0) {
    console.error(`[FallbackEngine] No mappings for tier: ${aliaModel.tier}`);
    recordFallbackEvent(normalizedModelId, attempts, null, null, false, Date.now() - startTime);
    return { resolved: null, attempts, totalAttempts: 0, usedFallback: false };
  }

  // Sort by priority (lower = higher priority)
  const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority);

  // Track providers to skip for this request (billing issues = skip all keys)
  const requestSkipProviders = new Set(skipProviders);
  // Track specific keys to skip (auth issues = skip that key, try others)
  const skipKeyIds = new Set<string>();
  // Track if we already retried a timeout on a given provider/model
  const timeoutRetried = new Set<string>();

  for (let i = 0; i < sortedMappings.length; i++) {
    const mapping = sortedMappings[i];

    // Skip providers that the caller or billing failures have excluded
    if (requestSkipProviders.has(mapping.provider)) {
      console.log(`[FallbackEngine] Skipping ${mapping.provider} (in skip list)`);
      continue;
    }

    // Check provider health (circuit breaker)
    const isAvailable = await isProviderAvailable(mapping.provider, mapping.modelId);
    if (!isAvailable) {
      console.warn(`[FallbackEngine] Skipping ${mapping.provider}/${mapping.modelId} - circuit breaker open`);
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
      normalizedModelId,
      tokens,
      i,
      skipKeyIds,
    );

    if (result.resolved) {
      // Success
      const usedFallback = i > 0 || attempts.length > 0;
      if (usedFallback) {
        console.log(`[FallbackEngine] Resolved via fallback: ${mapping.provider}/${mapping.modelId} (attempt ${attempts.length + 1})`);
      } else {
        console.log(`[FallbackEngine] Resolved ${normalizedModelId} -> ${mapping.provider}/${mapping.modelId}`);
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
        console.warn(`[FallbackEngine] Non-retryable error (${reason}), stopping fallback chain`);
        break;
      }

      switch (reason) {
        case 'timeout': {
          // Retry same provider once, then move to next
          const retryKey = `${mapping.provider}:${mapping.modelId}`;
          if (!timeoutRetried.has(retryKey)) {
            timeoutRetried.add(retryKey);
            console.log(`[FallbackEngine] Timeout on ${mapping.provider}/${mapping.modelId}, retrying once`);
            // Retry the same mapping (decrement i so the loop re-tries it)
            i--;
            continue;
          }
          // Already retried, move to next provider
          console.log(`[FallbackEngine] Timeout retry exhausted for ${mapping.provider}/${mapping.modelId}, moving to next`);
          break;
        }

        case 'rate_limit': {
          // Skip to next provider immediately
          console.log(`[FallbackEngine] Rate limited on ${mapping.provider}, skipping to next provider`);
          break;
        }

        case 'billing': {
          // Skip this provider entirely for the rest of this request
          requestSkipProviders.add(mapping.provider);
          console.log(`[FallbackEngine] Billing issue on ${mapping.provider}, skipping provider for this request`);
          break;
        }

        case 'auth': {
          // Skip that specific key, try next key for same provider
          if (result.failedKeyId) {
            skipKeyIds.add(result.failedKeyId);
            console.log(`[FallbackEngine] Auth issue on key, trying next key for ${mapping.provider}`);
            // Retry same mapping with different key
            i--;
            continue;
          }
          // No key ID available, move to next provider
          break;
        }

        default: {
          // 'unknown' - move to next provider
          console.log(`[FallbackEngine] Unknown error on ${mapping.provider}/${mapping.modelId}, trying next`);
          break;
        }
      }
    }
  }

  // All providers exhausted
  console.warn(`[FallbackEngine] All providers exhausted for ${normalizedModelId} (tier: ${aliaModel.tier})`);

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
    );

    if (!keyConfig) {
      return {
        resolved: null,
        attempt: {
          provider: mapping.provider,
          model: mapping.modelId,
          error: 'No available keys (all rate-limited or in cooldown)',
          reason: 'rate_limit',
          latencyMs: Date.now() - attemptStart,
        },
        failedKeyId: null,
      };
    }

    // Check if this specific key should be skipped (auth failures)
    if (keyConfig.keyId && skipKeyIds.has(keyConfig.keyId)) {
      return {
        resolved: null,
        attempt: {
          provider: mapping.provider,
          model: mapping.modelId,
          error: 'Key skipped due to previous auth failure',
          reason: 'auth',
          latencyMs: Date.now() - attemptStart,
        },
        failedKeyId: keyConfig.keyId,
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
  }).catch((err) => {
    console.error('[FallbackEngine] Failed to record fallback event:', err.message);
  });
}
