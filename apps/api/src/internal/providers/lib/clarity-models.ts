/**
 * Clarity Model Abstraction Layer
 *
 * This module defines the Clarity model tiers and their mappings to real provider models.
 * Users see only Clarity models (clarity-fast, clarity-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

export type ClarityTier = 'fast' | 'v1' | 'pro' | 'thinking' | 'pro-max';

export type ModelCategory = 'general' | 'coding';
export type PricingTier = 'free' | 'freemium' | 'paid';

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  voice: boolean;
  tools: boolean;
  codeExecution: boolean;
  webSearch: boolean;
  computerUse: boolean;
  streaming: boolean;
  systemPrompts: boolean;
  functionCalling: boolean;
  promptCaching: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface ClarityModel {
  id: string;
  name: string;
  tier: ClarityTier;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: ModelCategory;
  emoji?: string;
  chatVisible?: boolean;
}

export interface ModelMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: PricingTier;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  costPerMinute?: number;
  averageLatencyMs?: number;
  capabilities: ModelCapabilities;
}

/**
 * Clarity model definitions
 */
export const CLARITY_MODELS: Record<string, ClarityModel> = {
  'clarity-fast': {
    id: 'clarity-fast',
    name: 'Clarity Fast',
    tier: 'fast',
    description: 'Fast responses for simple tasks',
    creditMultiplier: 0.5,
    maxTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
    emoji: '\u26A1',
    chatVisible: true,
  },
  'clarity-v1': {
    id: 'clarity-v1',
    name: 'Clarity V1',
    tier: 'v1',
    description: 'Balanced performance for everyday tasks',
    creditMultiplier: 1,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\uD83C\uDFAF',
    chatVisible: true,
  },
  'clarity-pro': {
    id: 'clarity-pro',
    name: 'Clarity Pro',
    tier: 'pro',
    description: 'Advanced reasoning for complex tasks',
    creditMultiplier: 3,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\u2B50',
    chatVisible: true,
  },
  'clarity-thinking': {
    id: 'clarity-thinking',
    name: 'Clarity Thinking',
    tier: 'thinking',
    description: 'Extended thinking for complex problems',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\uD83E\uDDE0',
    chatVisible: true,
  },
  'clarity-pro-max': {
    id: 'clarity-pro-max',
    name: 'Clarity Pro Max',
    tier: 'pro-max',
    description: 'Best available models for demanding tasks',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\uD83D\uDE80',
    chatVisible: true,
  },
};

/**
 * Model mappings by tier (ordered by priority - lower priority number = try first)
 *
 * IMPORTANT: Only REAL, currently available models are mapped
 */

// Import the generated mappings with full capabilities and pricing data
import { GENERATED_TIER_MAPPINGS } from './generate-model-mappings';
import { isProviderAvailable } from './provider-health';
import { ClarityModel as ClarityModelDB } from '../models/clarity-model';
import { log } from '../../../lib/logger.js';
export const TIER_MODEL_MAPPINGS = GENERATED_TIER_MAPPINGS;

/**
 * Get Clarity model by ID
 */
export function getClarityModel(modelId: string): ClarityModel | null {
  return CLARITY_MODELS[modelId] || null;
}

/**
 * Check if a model ID is a Clarity model
 */
export function isClarityModel(modelId: string): boolean {
  return modelId in CLARITY_MODELS;
}

/**
 * Get model mappings for a tier
 */
export function getModelMappingsForTier(tier: ClarityTier): ModelMapping[] {
  return TIER_MODEL_MAPPINGS[tier] || [];
}

/**
 * Get all available Clarity models
 */
export function getAllClarityModels(): ClarityModel[] {
  return Object.values(CLARITY_MODELS);
}

/**
 * Get Clarity models by category
 */
export function getClarityModelsByCategory(category: ModelCategory): ClarityModel[] {
  return Object.values(CLARITY_MODELS).filter(m => m.category === category);
}

/**
 * Get the default model for a category (lowest credit multiplier)
 */
export function getDefaultModelForCategory(category: ModelCategory): ClarityModel | null {
  const models = getClarityModelsByCategory(category);
  if (models.length === 0) return null;
  return models.reduce((best, m) => m.creditMultiplier < best.creditMultiplier ? m : best);
}

export interface ClarityModelWithAvailability extends ClarityModel {
  isAvailable: boolean;
  isLegacy: boolean;
}

/**
 * Get all Clarity models with their current availability status.
 * A model is "available" if at least one provider in its tier has a healthy circuit breaker.
 * Legacy status is fetched from MongoDB (managed via admin tool).
 */
export async function getAvailableModels(): Promise<ClarityModelWithAvailability[]> {
  const models = getAllClarityModels();
  const results: ClarityModelWithAvailability[] = [];

  // Fetch legacy flags from MongoDB
  let legacyMap = new Map<string, boolean>();
  try {
    const dbModels = await ClarityModelDB.find({}).select('clarityModelId isLegacy').lean();
    for (const doc of dbModels) {
      legacyMap.set(doc.clarityModelId, doc.isLegacy ?? false);
    }
  } catch (err) {
    log.providers.warn({ data: err }, 'Failed to fetch legacy flags');
  }

  for (const model of models) {
    const mappings = TIER_MODEL_MAPPINGS[model.tier] || [];
    // A model is available if at least ONE provider in its tier is healthy
    let isAvailable = false;
    for (const mapping of mappings) {
      const available = await isProviderAvailable(mapping.provider, mapping.modelId);
      if (available) {
        isAvailable = true;
        break;
      }
    }
    results.push({
      ...model,
      isAvailable,
      isLegacy: legacyMap.get(model.id) ?? false,
    });
  }

  return results;
}
