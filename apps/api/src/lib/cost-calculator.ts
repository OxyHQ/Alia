/**
 * Cost Calculator
 *
 * Computes cost comparison between the actual provider used and the most
 * expensive provider in the same tier. This lets users see savings from
 * Clarity's smart multi-provider routing.
 *
 * All pricing data comes from existing ModelMapping.costPer1MInput/costPer1MOutput.
 */

import type { ModelMapping } from '../internal/providers/lib/clarity-models';
import { TIER_MODEL_MAPPINGS, getClarityModel } from '../internal/providers/lib/clarity-models';

export interface CostComparison {
  /** What the most expensive provider in this tier would have cost (USD) */
  premiumCostUsd: number;
  /** What the actual provider cost (USD) */
  actualCostUsd: number;
  /** Savings percentage (0-100) */
  savingsPercent: number;
}

/**
 * Calculate cost comparison for a completed chat request.
 *
 * @param clarityModelId - The Clarity model ID used (e.g., "clarity-v1")
 * @param actualProvider - The actual provider that served the request
 * @param actualModelId - The actual model ID used
 * @param promptTokens - Number of input tokens used
 * @param completionTokens - Number of output tokens used
 * @returns Cost comparison or null if pricing data is unavailable
 */
export function calculateCostComparison(
  clarityModelId: string,
  actualProvider: string,
  actualModelId: string,
  promptTokens: number,
  completionTokens: number,
): CostComparison | null {
  const clarityModel = getClarityModel(clarityModelId);
  if (!clarityModel) return null;

  const mappings = TIER_MODEL_MAPPINGS[clarityModel.tier];
  if (!mappings || mappings.length === 0) return null;

  // Find the most expensive mapping in the tier (premium benchmark)
  const premiumMapping = mappings.reduce<ModelMapping | null>((best, m) => {
    const cost = (m.costPer1MInput || 0) + (m.costPer1MOutput || 0);
    const bestCost = best ? (best.costPer1MInput || 0) + (best.costPer1MOutput || 0) : 0;
    return cost > bestCost ? m : best;
  }, null);

  if (!premiumMapping) return null;

  // Find the actual mapping used
  const actualMapping = mappings.find(
    m => m.provider === actualProvider && m.modelId === actualModelId,
  );

  // If we can't find the actual mapping, use 0 cost (free/unknown)
  const actualInputCost = actualMapping?.costPer1MInput || 0;
  const actualOutputCost = actualMapping?.costPer1MOutput || 0;

  const inputTokensM = promptTokens / 1_000_000;
  const outputTokensM = completionTokens / 1_000_000;

  const premiumCostUsd =
    (premiumMapping.costPer1MInput || 0) * inputTokensM +
    (premiumMapping.costPer1MOutput || 0) * outputTokensM;

  const actualCostUsd =
    actualInputCost * inputTokensM +
    actualOutputCost * outputTokensM;

  const savingsPercent = premiumCostUsd > 0
    ? Math.round((1 - actualCostUsd / premiumCostUsd) * 100)
    : 0;

  return {
    premiumCostUsd: Math.round(premiumCostUsd * 1_000_000) / 1_000_000, // 6 decimal places
    actualCostUsd: Math.round(actualCostUsd * 1_000_000) / 1_000_000,
    savingsPercent: Math.max(0, savingsPercent), // Never negative
  };
}
