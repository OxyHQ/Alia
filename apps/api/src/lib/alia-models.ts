/**
 * Alia Model Abstraction Layer
 *
 * This module defines the Alia model tiers and their mappings to real provider models.
 * Users see only Alia models (alia-lite, alia-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

export type AliaTier = 'lite' | 'v1' | 'v1-codea' | 'v1-cowork' | 'v1-browser' | 'v1-vision' | 'v1-audio' | 'v1-multimodal' | 'v1-pro' | 'v1-pro-max';

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
  'alia-v1-vision': {
    id: 'alia-v1-vision',
    name: 'Alia V1 Vision',
    tier: 'v1-vision',
    description: 'Specialized for image analysis, vision, and visual reasoning',
    creditMultiplier: 1.5,
    maxTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
  },
  'alia-v1-audio': {
    id: 'alia-v1-audio',
    name: 'Alia V1 Audio',
    tier: 'v1-audio',
    description: 'Specialized for audio transcription, speech-to-text, and audio analysis',
    creditMultiplier: 1.0,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
  },
  'alia-v1-multimodal': {
    id: 'alia-v1-multimodal',
    name: 'Alia V1 Multimodal',
    tier: 'v1-multimodal',
    description: 'Handles text, images, audio, and video in a single conversation',
    creditMultiplier: 2.0,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
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
 *
 * Special Capabilities by Model:
 * - groq/compound: Built-in web search & code execution tools
 * - openai/gpt-oss-120b: Built-in browser search & code execution
 * - gemini-3-pro: Vision, multimodal, 1M token context
 * - deepseek-v3.2: Thinking mode + tool use integration
 * - claude-sonnet-4.5/opus-4.5: Computer use capability, vision
 * - llama-3.2-11b-vision-instruct: Vision & image reasoning
 * - mistral-small-3.1-2503: Vision understanding, 128k context
 * - ministral-*: Image understanding (Apache 2.0 license)
 * - devstral-2: Agentic coding specialist, 256k context
 */
export const TIER_MODEL_MAPPINGS: Record<AliaTier, ModelMapping[]> = {
  'lite': [
    { provider: 'google', modelId: 'gemini-2.5-flash', priority: 1, qualityScore: 75 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 2, qualityScore: 65 },
    { provider: 'groq', modelId: 'openai/gpt-oss-20b', priority: 3, qualityScore: 68 },
    { provider: 'deepseek', modelId: 'deepseek-chat', priority: 4, qualityScore: 72 },
    { provider: 'mistral', modelId: 'ministral-8b-2512', priority: 5, qualityScore: 67 },
    { provider: 'together', modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', priority: 6, qualityScore: 65 },
  ],
  'v1': [
    { provider: 'google', modelId: 'gemini-3-flash-preview', priority: 1, qualityScore: 85 },
    { provider: 'deepseek', modelId: 'deepseek-chat', priority: 2, qualityScore: 83 },
    { provider: 'groq', modelId: 'openai/gpt-oss-120b', priority: 3, qualityScore: 82 },
    { provider: 'openai', modelId: 'gpt-4.1-mini', priority: 4, qualityScore: 82 },
    { provider: 'mistral', modelId: 'ministral-14b-2512', priority: 5, qualityScore: 78 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', priority: 6, qualityScore: 70 },
  ],
  'v1-codea': [
    { provider: 'deepseek', modelId: 'deepseek-chat', priority: 1, qualityScore: 94 }, // Excellent coding, free tier
    { provider: 'mistral', modelId: 'devstral-2', priority: 2, qualityScore: 93 }, // Agentic coding specialist, 256k context
    { provider: 'groq', modelId: 'groq/compound', priority: 3, qualityScore: 92 }, // Built-in code execution
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 4, qualityScore: 95 }, // Computer use
    { provider: 'google', modelId: 'gemini-3-pro', priority: 5, qualityScore: 92 },
    { provider: 'openai', modelId: 'gpt-5.2-codex', priority: 6, qualityScore: 93 },
  ],
  'v1-cowork': [
    { provider: 'deepseek', modelId: 'deepseek-chat', priority: 1, qualityScore: 93 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 2, qualityScore: 95 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 3, qualityScore: 92 },
    { provider: 'openai', modelId: 'gpt-5.2-instant', priority: 4, qualityScore: 90 },
    { provider: 'mistral', modelId: 'mistral-large-2512', priority: 5, qualityScore: 89 },
  ],
  'v1-browser': [
    // Prioritize models with built-in browser/tool capabilities
    { provider: 'groq', modelId: 'groq/compound', priority: 1, qualityScore: 95 }, // Built-in web search & code execution
    { provider: 'groq', modelId: 'openai/gpt-oss-120b', priority: 2, qualityScore: 93 }, // Built-in browser search & code execution
    { provider: 'google', modelId: 'gemini-3-pro', priority: 3, qualityScore: 94 }, // Vision & multimodal, 1M tokens
    { provider: 'deepseek', modelId: 'deepseek-v3.2', priority: 4, qualityScore: 92 }, // Thinking + tool use integration
    { provider: 'cloudflare', modelId: '@cf/meta/llama-4-scout-17b-16e-instruct', priority: 5, qualityScore: 89 }, // Multimodal, free tier
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 6, qualityScore: 96 }, // Computer use capability
    { provider: 'openai', modelId: 'gpt-5.2-instant', priority: 7, qualityScore: 90 },
    { provider: 'cloudflare', modelId: '@cf/meta/llama-3.2-11b-vision-instruct', priority: 8, qualityScore: 86 }, // Vision & reasoning, free
  ],
  'v1-vision': [
    // Prioritize vision-specialized models
    { provider: 'google', modelId: 'gemini-3-pro', priority: 1, qualityScore: 96 }, // Best multimodal, 1M tokens
    { provider: 'cloudflare', modelId: '@cf/meta/llama-4-scout-17b-16e-instruct', priority: 2, qualityScore: 90 }, // Native multimodal, free
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 3, qualityScore: 95 }, // Excellent vision
    { provider: 'openai', modelId: 'gpt-5.2-instant', priority: 4, qualityScore: 92 }, // Vision support
    { provider: 'cloudflare', modelId: '@cf/meta/llama-3.2-11b-vision-instruct', priority: 5, qualityScore: 88 }, // Vision specialist, free
    { provider: 'mistral', modelId: 'mistral-small-3.1-2503', priority: 6, qualityScore: 87 }, // Vision understanding
  ],
  'v1-audio': [
    // Prioritize audio/speech models
    { provider: 'groq', modelId: 'whisper-large-v3-turbo', priority: 1, qualityScore: 95 }, // Fast transcription, free
    { provider: 'groq', modelId: 'whisper-large-v3', priority: 2, qualityScore: 93 }, // High quality transcription
    { provider: 'openai', modelId: 'whisper-1', priority: 3, qualityScore: 92 },
    { provider: 'google', modelId: 'gemini-2.5-flash-native-audio-preview-12-2025', priority: 4, qualityScore: 90 }, // Native audio
  ],
  'v1-multimodal': [
    // Best models for handling multiple modalities (text, image, audio, video)
    { provider: 'google', modelId: 'gemini-3-pro', priority: 1, qualityScore: 98 }, // Best multimodal, 1M tokens
    { provider: 'anthropic', modelId: 'claude-opus-4.5', priority: 2, qualityScore: 97 },
    { provider: 'cloudflare', modelId: '@cf/meta/llama-4-scout-17b-16e-instruct', priority: 3, qualityScore: 92 }, // Native multimodal, free
    { provider: 'openai', modelId: 'gpt-5.2-thinking', priority: 4, qualityScore: 95 },
    { provider: 'mistral', modelId: 'mistral-large-2512', priority: 5, qualityScore: 90 },
  ],
  'v1-pro': [
    { provider: 'deepseek', modelId: 'deepseek-reasoner', priority: 1, qualityScore: 96 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4.5', priority: 2, qualityScore: 95 },
    { provider: 'openai', modelId: 'gpt-5.2-thinking', priority: 3, qualityScore: 94 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 4, qualityScore: 92 },
    { provider: 'mistral', modelId: 'mistral-large-2512', priority: 5, qualityScore: 91 },
  ],
  'v1-pro-max': [
    { provider: 'anthropic', modelId: 'claude-opus-4.5', priority: 1, qualityScore: 98 },
    { provider: 'openai', modelId: 'gpt-5.2-pro', priority: 2, qualityScore: 96 },
    { provider: 'deepseek', modelId: 'deepseek-v3.2', priority: 3, qualityScore: 95 },
    { provider: 'google', modelId: 'gemini-3-pro', priority: 4, qualityScore: 94 },
    { provider: 'mistral', modelId: 'mistral-large-2512', priority: 5, qualityScore: 92 },
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
