/**
 * Alia Model Abstraction Layer
 *
 * This module defines the Alia model tiers and their mappings to real provider models.
 * Users see only Alia models (alia-lite, alia-v1, etc.) while internally
 * requests are routed to appropriate provider models.
 */

export type AliaTier = 'lite' | 'v1' | 'v1-codea' | 'v1-cowork' | 'v1-browser' | 'v1-vision' | 'v1-audio' | 'v1-tts' | 'v1-multimodal' | 'v1-pro' | 'v1-pro-max' | 'v1-voice' | 'v1-voice-pro';

export type ModelCategory = 'general' | 'coding' | 'vision' | 'audio' | 'multimodal' | 'voice';
export type PricingTier = 'free' | 'freemium' | 'paid';

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  voice: boolean;                // Real-time voice conversations
  tools: boolean;
  codeExecution: boolean;       // Built-in code execution (Groq Compound)
  webSearch: boolean;            // Built-in web search (GPT-OSS)
  computerUse: boolean;          // Claude computer use
  streaming: boolean;
  systemPrompts: boolean;
  functionCalling: boolean;
  promptCaching: boolean;        // Claude/OpenAI prompt caching support
  maxContextTokens: number;      // 8k, 128k, 1M, etc.
  maxOutputTokens: number;
}

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
  emoji?: string;
  chatVisible?: boolean;
}

export interface ModelMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: PricingTier;
  costPer1MInput?: number;       // USD per 1M input tokens
  costPer1MOutput?: number;      // USD per 1M output tokens
  costPerMinute?: number;        // USD per minute (for voice/realtime models)
  averageLatencyMs?: number;     // Tracked performance
  capabilities: ModelCapabilities;
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
    emoji: '⚡',
    chatVisible: true,
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
    emoji: '🎯',
    chatVisible: true,
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
    emoji: '💻',
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
    emoji: '🖥️',
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
    emoji: '🌐',
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
    category: 'vision',
    emoji: '👁️',
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
    category: 'audio',
    emoji: '🎤',
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
    category: 'multimodal',
    emoji: '🎨',
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
    emoji: '⭐',
    chatVisible: true,
  },
  'alia-v1-thinking': {
    id: 'alia-v1-thinking',
    name: 'Alia V1 Thinking',
    tier: 'v1-pro-max',
    description: 'Extended thinking for complex problems',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'coding',
    emoji: '🧠',
    chatVisible: true,
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
    emoji: '🚀',
    chatVisible: true,
  },
  'alia-v1-voice': {
    id: 'alia-v1-voice',
    name: 'Alia V1 Voice',
    tier: 'v1-voice',
    description: 'Real-time voice conversations with low latency',
    creditMultiplier: 2.0,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'voice',
    emoji: '🗣️',
  },
  'alia-v1-voice-pro': {
    id: 'alia-v1-voice-pro',
    name: 'Alia V1 Voice Pro',
    tier: 'v1-voice-pro',
    description: 'Premium voice with extended context and advanced features',
    creditMultiplier: 4.0,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: false,
    category: 'voice',
    emoji: '🎙️',
  },
};

/**
 * Model mappings by tier (ordered by priority - lower priority number = try first)
 *
 * IMPORTANT: Only REAL, currently available models are mapped
 *
 * Special Capabilities by Model:
 * - gemini-3-flash-preview: Vision, code execution, web search (urlContext), 1M context
 * - gemini-3-pro-preview: Vision, code execution, web search, 1M context, extended output
 * - gemini-2.5-pro: Vision, multimodal, 2M token context, prompt caching
 * - deepseek-reasoner: Advanced reasoning and thinking mode
 * - claude-sonnet-4/opus-4: Computer use capability, vision, prompt caching
 * - gpt-4o: Vision, 128k context, fast multimodal responses
 * - o1: Advanced reasoning, 200k context, extended thinking
 * - llama-3.2-11b-vision-instruct: Vision & image reasoning (Cloudflare)
 * - llama-3.3-70b-versatile: Fast, versatile, 128k context (Groq)
 */

// Import the generated mappings with full capabilities and pricing data
import { GENERATED_TIER_MAPPINGS } from './generate-model-mappings';
import { isProviderAvailable } from './provider-health';
import { AliaModel as AliaModelDB } from '../models/alia-model';
import { log } from '../../../lib/logger.js';
export const TIER_MODEL_MAPPINGS = GENERATED_TIER_MAPPINGS;

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

/**
 * Get the default model for a category (lowest credit multiplier)
 */
export function getDefaultModelForCategory(category: ModelCategory): AliaModel | null {
  const models = getAliaModelsByCategory(category);
  if (models.length === 0) return null;
  return models.reduce((best, m) => m.creditMultiplier < best.creditMultiplier ? m : best);
}

export interface AliaModelWithAvailability extends AliaModel {
  isAvailable: boolean;
  isLegacy: boolean;
}

/**
 * Get all Alia models with their current availability status.
 * A model is "available" if at least one provider in its tier has a healthy circuit breaker.
 * Legacy status is fetched from MongoDB (managed via admin tool).
 */
export async function getAvailableModels(): Promise<AliaModelWithAvailability[]> {
  const models = getAllAliaModels();
  const results: AliaModelWithAvailability[] = [];

  // Fetch legacy flags from MongoDB
  let legacyMap = new Map<string, boolean>();
  try {
    const dbModels = await AliaModelDB.find({}).select('aliasModelId isLegacy').lean();
    for (const doc of dbModels) {
      legacyMap.set(doc.aliasModelId, doc.isLegacy ?? false);
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
        break; // No need to check more - at least one is available
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
