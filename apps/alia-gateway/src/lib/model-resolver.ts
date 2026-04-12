/**
 * Model Resolver
 *
 * Resolves Alia model IDs to concrete provider/model combinations.
 * Delegates to the fallback engine for smart retry logic, key cooldown,
 * and analytics recording.
 *
 * Includes a short-lived in-memory cache (5 s TTL) to absorb burst traffic
 * without repeated DB round-trips. The cache is keyed by
 * {model, skipProviders, skipKeyIds} so different retry contexts get
 * independent entries.
 *
 * The public API (resolveAliaModel) remains backward-compatible.
 */

import type { KeyConfig } from './types';
import {
  ALIA_MODELS,
  isAliaModel,
  getAliaModel,
  type AliaModel,
  type AliaTier,
} from './alia-models';
import { resolveWithFallback, type FallbackResult, type FallbackAttempt } from './fallback-engine';

export interface ResolvedModel {
  aliasModelId: string;
  provider: string;
  modelId: string;
  keyConfig: KeyConfig;
  aliaModel: AliaModel;
  isFallback: boolean;
  fallbackIndex: number;
}

// ============== RESOLVE CACHE ==============

interface ResolveCacheEntry {
  result: ResolvedModel;
  expiresAt: number;
}

const resolveCache = new Map<string, ResolveCacheEntry>();
const RESOLVE_CACHE_TTL = 5_000; // 5 seconds

function getResolveCacheKey(
  model: string,
  skipProviders: Set<string>,
  skipKeyIds: Set<string>,
): string {
  return `${model}:${[...skipProviders].sort().join(',')}:${[...skipKeyIds].sort().join(',')}`;
}

/**
 * Clear the resolve cache. Call this when keys change (e.g., after a key
 * failure/success, priority rotation, or admin key update).
 */
export function clearResolveCache(): void {
  resolveCache.clear();
}

// ============== PUBLIC API ==============

/**
 * Resolve an Alia model ID to a concrete provider and model.
 *
 * Keys are loaded internally from MongoDB via key-manager.
 * Uses the fallback engine for smart retry logic based on error classification.
 * Results are cached for 5 seconds to absorb burst traffic.
 *
 * @param requestedModel - The model ID requested (can be Alia model or legacy model name)
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip (for retry scenarios)
 * @param skipKeyIds - Optional set of key IDs to skip
 * @returns Resolved model with key config, or null if no models available
 */
export async function resolveAliaModel(
  requestedModel: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds: Set<string> = new Set()
): Promise<ResolvedModel | null> {
  // Check cache
  const cacheKey = getResolveCacheKey(requestedModel, skipProviders, skipKeyIds);
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  // Cache miss or expired — resolve via fallback engine
  const result = await resolveWithFallback(requestedModel, tokens, skipProviders, skipKeyIds);

  // Cache successful resolutions only (don't cache nulls so retries re-evaluate)
  if (result.resolved) {
    resolveCache.set(cacheKey, {
      result: result.resolved,
      expiresAt: Date.now() + RESOLVE_CACHE_TTL,
    });
  }

  return result.resolved;
}

/**
 * Extended resolution that returns the full fallback result including attempt history.
 * Use this when you need access to fallback analytics (e.g., for logging or debugging).
 *
 * NOTE: This bypasses the resolve cache intentionally — callers that need attempt
 * history typically need a fresh resolution (e.g., retry flows after a failure).
 *
 * @param requestedModel - The model ID requested
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip
 * @param skipKeyIds - Optional set of key IDs to skip
 * @returns Full FallbackResult with resolved model, attempts, and metadata
 */
export async function resolveAliaModelWithAttempts(
  requestedModel: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds: Set<string> = new Set()
): Promise<FallbackResult> {
  return resolveWithFallback(requestedModel, tokens, skipProviders, skipKeyIds);
}

/**
 * Get the default Alia model ID
 */
export function getDefaultAliaModel(): string {
  return 'alia-lite';
}

/**
 * Validate if a model ID is a valid Alia model
 */
export function isValidModel(modelId: string): boolean {
  return isAliaModel(modelId);
}

// Re-export utilities from alia-models
export { isAliaModel, getAliaModel, ALIA_MODELS, type AliaModel, type AliaTier };

// Re-export fallback types for consumers
export type { FallbackResult, FallbackAttempt };
