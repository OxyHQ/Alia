/**
 * Alia Model Abstraction Layer
 *
 * This module defines the Alia model tiers and their mappings to real provider models.
 * Users see only Alia models (alia-lite, alia-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

export type AliaTier = 'lite' | 'v1' | 'v1-codea' | 'v1-cowork' | 'v1-browser' | 'v1-pro' | 'v1-pro-max';

export type ModelCategory = 'general' | 'coding';

export interface AliaModel {
  id: string;
  name: string;
  tier: AliaTier;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: ModelCategory;
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
    category: 'general',
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
    category: 'general',
  },
  'alia-v1-codea': {
    id: 'alia-v1-codea',
    name: 'Codea',
    tier: 'v1-codea',
    description: 'Fast coding assistant',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: false,
    category: 'coding',
  },
  'alia-v1-cowork': {
    id: 'alia-v1-cowork',
    name: 'Alia V1 Cowork',
    tier: 'v1-cowork',
    description: 'Desktop automation assistant with tool support',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
  },
  'alia-v1-browser': {
    id: 'alia-v1-browser',
    name: 'Alia V1 Browser',
    tier: 'v1-browser',
    description: 'Browser automation specialist for web interactions',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
  },
  'alia-v1-pro': {
    id: 'alia-v1-pro',
    name: 'Codea Pro',
    tier: 'v1-pro',
    description: 'Advanced reasoning for complex tasks',
    creditMultiplier: 3,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
  },
  'alia-v1-thinking': {
    id: 'alia-v1-thinking',
    name: 'Codea Thinking',
    tier: 'v1-pro-max',
    description: 'Extended thinking for complex problems',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
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
    category: 'general',
  },
};

/**
 * Model mappings by tier (ordered by priority - lower priority number = try first)
 */
export const TIER_MODEL_MAPPINGS: Record<AliaTier, ModelMapping[]> = {
  'lite': [
    { provider: 'google', modelId: 'gemini-2.5-flash', priority: 1, qualityScore: 75 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 2, qualityScore: 65 },
    { provider: 'groq', modelId: 'openai/gpt-oss-20b', priority: 3, qualityScore: 68 },
    { provider: 'together', modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', priority: 4, qualityScore: 65 },
  ],
  'v1': [
    { provider: 'google', modelId: 'gemini-3-flash-preview', priority: 1, qualityScore: 85 },
    { provider: 'openai', modelId: 'gpt-4.1-mini', priority: 2, qualityScore: 82 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 3, qualityScore: 70 },
  ],
  'v1-codea': [
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 1, qualityScore: 95 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 2, qualityScore: 92 },
    { provider: 'openai', modelId: 'gpt-5.2-codex', priority: 3, qualityScore: 93 },
  ],
  'v1-cowork': [
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 1, qualityScore: 95 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 2, qualityScore: 92 },
    { provider: 'openai', modelId: 'gpt-5.2-instant', priority: 3, qualityScore: 90 },
  ],
  'v1-browser': [
    { provider: 'google', modelId: 'gemini-3-pro', priority: 1, qualityScore: 94 },
    { provider: 'groq', modelId: 'openai/gpt-oss-120b', priority: 2, qualityScore: 90 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 3, qualityScore: 88 },
    { provider: 'openai', modelId: 'gpt-5.2-instant', priority: 4, qualityScore: 92 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 5, qualityScore: 96 },
  ],
  'v1-pro': [
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 1, qualityScore: 95 },
    { provider: 'openai', modelId: 'gpt-5.2-thinking', priority: 2, qualityScore: 94 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 3, qualityScore: 92 },
  ],
  'v1-pro-max': [
    { provider: 'anthropic', modelId: 'claude-opus-4.5', priority: 1, qualityScore: 98 },
    { provider: 'openai', modelId: 'gpt-5.2-pro', priority: 2, qualityScore: 96 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 3, qualityScore: 94 },
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

/**
 * Get Alia models by category
 */
export function getAliaModelsByCategory(category: ModelCategory): AliaModel[] {
  return Object.values(ALIA_MODELS).filter(m => m.category === category);
}
