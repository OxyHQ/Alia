/**
 * Alia Model Abstraction Layer
 *
 * This module defines the Alia model tiers and their mappings to real provider models.
 * Users see only Alia models (alia-lite, alia-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

export type AliaTier = 'lite' | 'v1' | 'v1-codea' | 'v1-pro' | 'v1-pro-max';

export interface AliaModel {
  id: string;
  name: string;
  tier: AliaTier;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface ModelMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
}

/**
 * Alia model definitions
 */
export const ALIA_MODELS: Record<string, AliaModel> = {
  'alia-lite': {
    id: 'alia-lite',
    name: 'Alia Lite',
    tier: 'lite',
    description: 'Fast responses for simple tasks',
    creditMultiplier: 0.5,
    maxTokens: 4096,
    supportsTools: true,
    supportsVision: false,
  },
  'alia-v1': {
    id: 'alia-v1',
    name: 'Alia V1',
    tier: 'v1',
    description: 'Balanced performance for everyday tasks',
    creditMultiplier: 1,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
  },
  'alia-v1-codea': {
    id: 'alia-v1-codea',
    name: 'Alia V1 Codea',
    tier: 'v1-codea',
    description: 'Optimized for coding and technical tasks',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: false,
  },
  'alia-v1-pro': {
    id: 'alia-v1-pro',
    name: 'Alia V1 Pro',
    tier: 'v1-pro',
    description: 'High-quality responses for complex tasks',
    creditMultiplier: 3,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
  },
  'alia-v1-pro-max': {
    id: 'alia-v1-pro-max',
    name: 'Alia V1 Pro Max',
    tier: 'v1-pro-max',
    description: 'Best available models for demanding tasks',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
  },
};

/**
 * Model mappings by tier (ordered by priority - lower priority number = try first)
 */
export const TIER_MODEL_MAPPINGS: Record<AliaTier, ModelMapping[]> = {
  'lite': [
    { provider: 'google', modelId: 'gemini-2.0-flash', priority: 1, qualityScore: 70 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 2, qualityScore: 65 },
    { provider: 'cerebras', modelId: 'llama-3.3-70b', priority: 3, qualityScore: 60 },
    { provider: 'together', modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', priority: 4, qualityScore: 65 },
  ],
  'v1': [
    { provider: 'google', modelId: 'gemini-2.5-flash', priority: 1, qualityScore: 80 },
    { provider: 'openai', modelId: 'gpt-4o-mini', priority: 2, qualityScore: 78 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 3, qualityScore: 70 },
  ],
  'v1-codea': [
    { provider: 'google', modelId: 'gemini-2.5-pro', priority: 1, qualityScore: 90 },
    { provider: 'openai', modelId: 'gpt-4o', priority: 2, qualityScore: 88 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', priority: 3, qualityScore: 92 },
  ],
  'v1-pro': [
    { provider: 'openai', modelId: 'gpt-4o', priority: 1, qualityScore: 90 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', priority: 2, qualityScore: 92 },
    { provider: 'google', modelId: 'gemini-2.5-pro', priority: 3, qualityScore: 88 },
  ],
  'v1-pro-max': [
    { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', priority: 1, qualityScore: 95 },
    { provider: 'openai', modelId: 'gpt-4o', priority: 2, qualityScore: 93 },
    { provider: 'google', modelId: 'gemini-2.5-pro', priority: 3, qualityScore: 90 },
  ],
};

/**
 * Get Alia model by ID
 */
export function getAliaModel(modelId: string): AliaModel | null {
  return ALIA_MODELS[modelId] || null;
}

/**
 * Check if a model ID is an Alia model
 */
export function isAliaModel(modelId: string): boolean {
  return modelId in ALIA_MODELS;
}

/**
 * Get model mappings for a tier
 */
export function getModelMappingsForTier(tier: AliaTier): ModelMapping[] {
  return TIER_MODEL_MAPPINGS[tier] || [];
}

/**
 * Get all available Alia models
 */
export function getAllAliaModels(): AliaModel[] {
  return Object.values(ALIA_MODELS);
}
