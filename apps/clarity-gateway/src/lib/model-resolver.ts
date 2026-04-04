/**
 * Model Resolver
 *
 * Resolves Clarity model IDs to concrete provider/model combinations.
 * Delegates to the fallback engine for smart retry logic, key cooldown,
 * and analytics recording.
 *
 * The public API (resolveClarityModel) remains backward-compatible.
 */

import type { KeyConfig } from './types';
import {
  CLARITY_MODELS,
  TIER_MODEL_MAPPINGS,
  isClarityModel,
  getClarityModel,
  type ClarityModel,
  type ClarityTier,
} from './clarity-models';
import { resolveWithFallback, type FallbackResult, type FallbackAttempt } from './fallback-engine';

export interface ResolvedModel {
  clarityModelId: string;
  provider: string;
  modelId: string;
  keyConfig: KeyConfig;
  clarityModel: ClarityModel;
  isFallback: boolean;
  fallbackIndex: number;
}

/**
 * Resolve an Clarity model ID to a concrete provider and model.
 *
 * Keys are loaded internally from MongoDB via key-manager.
 * Uses the fallback engine for smart retry logic based on error classification.
 *
 * @param requestedModel - The model ID requested (can be Clarity model or legacy model name)
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip (for retry scenarios)
 * @returns Resolved model with key config, or null if no models available
 */
export async function resolveClarityModel(
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
 * @param skipKeyIds - Optional set of key IDs to skip
 * @returns Full FallbackResult with resolved model, attempts, and metadata
 */
export async function resolveClarityModelWithAttempts(
  requestedModel: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds: Set<string> = new Set()
): Promise<FallbackResult> {
  return resolveWithFallback(requestedModel, tokens, skipProviders, skipKeyIds);
}

/**
 * Get the default Clarity model ID
 */
export function getDefaultClarityModel(): string {
  return 'clarity-fast';
}

/**
 * Validate if a model ID is a valid Clarity model
 */
export function isValidModel(modelId: string): boolean {
  return isClarityModel(modelId);
}

// Re-export utilities from clarity-models
export { isClarityModel, getClarityModel, CLARITY_MODELS, type ClarityModel, type ClarityTier };

// Re-export fallback types for consumers
export type { FallbackResult, FallbackAttempt };
