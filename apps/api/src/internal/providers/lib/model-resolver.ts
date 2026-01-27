/**
 * Model Resolver
 *
 * Resolves Alia model IDs to concrete provider/model combinations.
 * Handles fallback logic within tiers when primary models are unavailable.
 * Integrates provider health monitoring for automatic failure handling.
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
import { getBestKeyForModel } from './load-balancer';
import { isProviderAvailable } from './provider-health';

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
 * @param requestedModel - The model ID requested (can be Alia model or legacy model name)
 * @param keyPool - Pool of available API keys
 * @param tokens - Estimated tokens for rate limit checking
 * @param skipProviders - Optional set of providers to skip (for retry scenarios)
 * @returns Resolved model with key config, or null if no models available
 */
export async function resolveAliaModel(
  requestedModel: string,
  keyPool: KeyConfig[],
  tokens: number = 1000,
  skipProviders: Set<string> = new Set()
): Promise<ResolvedModel | null> {
  // Get Alia model config (default to alia-v1 if invalid)
  const aliasModelId = isAliaModel(requestedModel) ? requestedModel : 'alia-v1';
  const aliaModel = getAliaModel(aliasModelId);

  if (!aliaModel) {
    console.error(`[ModelResolver] Failed to get model config for: ${aliasModelId}`);
    return null;
  }

  // Get model mappings for this tier
  const mappings = TIER_MODEL_MAPPINGS[aliaModel.tier];

  if (!mappings || mappings.length === 0) {
    console.error(`[ModelResolver] No mappings for tier: ${aliaModel.tier}`);
    return null;
  }

  // Sort by priority (lower = higher priority)
  const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority);

  // Try each model in priority order
  for (let i = 0; i < sortedMappings.length; i++) {
    const mapping = sortedMappings[i];

    // Skip providers that have failed (for retry scenarios)
    if (skipProviders.has(mapping.provider)) {
      console.log(`[ModelResolver] Skipping ${mapping.provider} (in skip list)`);
      continue;
    }

    // Check provider health (circuit breaker)
    const isAvailable = await isProviderAvailable(mapping.provider, mapping.modelId);
    if (!isAvailable) {
      console.warn(`[ModelResolver] ⚠️ Skipping ${mapping.provider}/${mapping.modelId} - circuit breaker open (unhealthy)`);
      continue;
    }

    console.log(`[ModelResolver] Trying ${mapping.provider}/${mapping.modelId} (priority ${mapping.priority})`);

    const keyConfig = await getBestKeyForModel(
      keyPool,
      mapping.provider,
      mapping.modelId,
      tokens
    );

    if (keyConfig) {
      const isFallback = i > 0;
      if (isFallback) {
        console.log(`[ModelResolver] Using fallback: ${mapping.provider}/${mapping.modelId} (was priority ${i + 1})`);
      } else {
        console.log(`[ModelResolver] Resolved ${aliasModelId} -> ${mapping.provider}/${mapping.modelId}`);
      }

      return {
        aliasModelId,
        provider: mapping.provider,
        modelId: mapping.modelId,
        keyConfig,
        aliaModel,
        isFallback,
        fallbackIndex: i,
      };
    }
  }

  console.warn(`[ModelResolver] No available keys for any model in tier: ${aliaModel.tier}`);
  return null;
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
