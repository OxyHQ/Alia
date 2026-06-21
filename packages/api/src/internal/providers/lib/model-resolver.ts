/**
 * Model Resolver
 *
 * Resolves Alia model IDs to concrete provider/model combinations.
 * Delegates to the fallback engine for smart retry logic, key cooldown,
 * and analytics recording.
 *
 * The public API (resolveAliaModel) remains backward-compatible.
 */

import type { KeyConfig } from './types';
import {
  ALIA_MODELS,
  TIER_MODEL_MAPPINGS,
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

/**
 * Resolve an Alia model ID to a concrete provider and model.
 *
 * Keys are loaded internally from MongoDB via key-manager.
 * Uses the fallback engine for smart retry logic based on error classification.
 *
 * @param requestedModel - The model ID requested (can be Alia model or legacy model name)
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip (for retry scenarios)
 * @returns Resolved model with key config, or null if no models available
 */
export async function resolveAliaModel(
  requestedModel: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds: Set<string> = new Set()
): Promise<ResolvedModel | null> {
  const result = await resolveWithFallback(requestedModel, tokens, skipProviders, skipKeyIds);
  return result.resolved;
}

/**
 * Extended resolution that returns the full fallback result including attempt history.
 * Use this when you need access to fallback analytics (e.g., for logging or debugging).
 *
 * @param requestedModel - The model ID requested
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip
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
  return 'alia-v1';
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
