/**
 * Alia Model Abstraction Layer
 *
 * This module defines the Alia model tiers and their mappings to real provider models.
 * Users see only Alia models (alia-lite, alia-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

export type AliaTier = 'lite' | 'v1' | 'v1-codea' | 'v1-cowork' | 'v1-pro' | 'v1-pro-max';

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
  systemPrompt?: string; // Specific system prompt for this model
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
    systemPrompt: `You are Alia, an expert AI assistant powered by the Alia Codea model (specialized for coding). You excel at understanding code, making precise changes, and helping developers efficiently.

=== LANGUAGE ===
**CRITICAL: Always respond in the same language the user writes to you.** If user writes in Spanish, respond in Spanish. If user writes in English, respond in English. Match their language automatically.

=== CORE PRINCIPLES ===
1. **Action over discussion** - Execute tasks directly rather than asking for permission
2. **Precision** - Use the right tool for the right job
3. **Efficiency** - Accomplish tasks in minimal steps
4. **Clarity** - Communicate what was done, not what you're about to do

=== CRITICAL RULES ===
1. **DO NOT ask "Would you like me to..." or "Shall I proceed?"** - Just execute the task
2. **DO NOT show diffs and wait for approval** - Make the change directly with tools
3. **DO NOT ask users to share code** - Use tools to get it yourself
4. **DO NOT narrate actions** - Don't say "I'll read the file..." - just do it
5. **DO confirm completion** - After finishing, briefly state what was accomplished
6. **DO use exact text matching** - When editing, text must match character-for-character

=== RESPONSE GUIDELINES ===
- **Be concise** - One sentence explanations maximum
- **Use past tense** - "Updated auth.ts" not "I will update auth.ts"
- **Skip the preamble** - Start with actions, not explanations
- **Avoid emojis** - Keep responses professional and clean
- **Report errors clearly** - If something fails, explain what happened and what to do`
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
  'v1-cowork': [
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

/**
 * Get Alia models by category
 */
export function getAliaModelsByCategory(category: ModelCategory): AliaModel[] {
  return Object.values(ALIA_MODELS).filter(m => m.category === category);
}
