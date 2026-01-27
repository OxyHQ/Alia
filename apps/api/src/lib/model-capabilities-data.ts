/**
 * Model Capabilities Database
 *
 * Comprehensive capability definitions for all supported models
 */

import type { ModelCapabilities, PricingTier } from './alia-models';

// ============== CAPABILITY PRESETS ==============

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: false,
  audio: false,
  video: false,
  tools: true,
  codeExecution: false,
  webSearch: false,
  computerUse: false,
  streaming: true,
  systemPrompts: true,
  functionCalling: true,
  promptCaching: false,
  maxContextTokens: 8192,
  maxOutputTokens: 4096,
};

// Helper to create capabilities with overrides
export function createCapabilities(overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

// ============== MODEL-SPECIFIC CAPABILITIES ==============

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // Google Gemini (REAL models only)
  'gemini-2.5-flash': createCapabilities({
    vision: true,
    maxContextTokens: 1000000,
    maxOutputTokens: 8192,
  }),
  'gemini-2.5-pro': createCapabilities({
    vision: true,
    maxContextTokens: 2000000,
    maxOutputTokens: 8192,
    promptCaching: true,
  }),
  'gemini-3-flash-preview': createCapabilities({
    vision: true,
    codeExecution: true,       // Built-in code execution
    webSearch: true,            // URL context/grounding capability
    maxContextTokens: 1000000,
    maxOutputTokens: 8192,
  }),
  'gemini-3-pro-preview': createCapabilities({
    vision: true,
    codeExecution: true,       // Built-in code execution
    webSearch: true,            // URL context/grounding capability
    maxContextTokens: 1000000,
    maxOutputTokens: 64000,
    promptCaching: true,
  }),

  // Groq
  'llama-3.3-70b-versatile': createCapabilities({
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
  'openai/gpt-oss-20b': createCapabilities({
    codeExecution: true,
    webSearch: true,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  }),
  'openai/gpt-oss-120b': createCapabilities({
    codeExecution: true,
    webSearch: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
  'groq/compound': createCapabilities({
    codeExecution: true,
    webSearch: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
  'whisper-large-v3-turbo': createCapabilities({
    audio: true,
    tools: false,
    functionCalling: false,
    maxContextTokens: 4096,
    maxOutputTokens: 4096,
  }),
  'whisper-large-v3': createCapabilities({
    audio: true,
    tools: false,
    functionCalling: false,
    maxContextTokens: 4096,
    maxOutputTokens: 4096,
  }),

  // DeepSeek
  'deepseek-chat': createCapabilities({
    maxContextTokens: 64000,
    maxOutputTokens: 8192,
  }),
  'deepseek-reasoner': createCapabilities({
    maxContextTokens: 64000,
    maxOutputTokens: 8192,
  }),
  'deepseek-v3.2': createCapabilities({
    maxContextTokens: 64000,
    maxOutputTokens: 8192,
  }),

  // Mistral
  'ministral-8b-2512': createCapabilities({
    vision: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
  'ministral-14b-2512': createCapabilities({
    vision: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
  'devstral-2': createCapabilities({
    maxContextTokens: 256000,
    maxOutputTokens: 8192,
  }),
  'mistral-large-2512': createCapabilities({
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
  'mistral-small-3.1-2503': createCapabilities({
    vision: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),

  // Anthropic Claude (REAL models only)
  'claude-sonnet-4-20250514': createCapabilities({
    vision: true,
    computerUse: true,
    promptCaching: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
  }),
  'claude-opus-4-20241120': createCapabilities({
    vision: true,
    computerUse: true,
    promptCaching: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
  }),

  // OpenAI (REAL models only)
  'gpt-4o': createCapabilities({
    vision: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
  }),
  'gpt-4o-mini': createCapabilities({
    vision: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
  }),
  'o1': createCapabilities({
    vision: true,
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
  }),
  'whisper-1': createCapabilities({
    audio: true,
    tools: false,
    functionCalling: false,
    maxContextTokens: 4096,
    maxOutputTokens: 4096,
  }),

  // Cloudflare (REAL models only)
  '@cf/meta/llama-3.2-11b-vision-instruct': createCapabilities({
    vision: true,
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),

  // Together AI
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': createCapabilities({
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
};

// ============== PRICING DATABASE ==============

export interface ModelPricing {
  tier: PricingTier;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  averageLatencyMs?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Free tier models (Google Gemini via free API)
  'gemini-2.5-flash': { tier: 'free', costPer1MInput: 0.075, costPer1MOutput: 0.30, averageLatencyMs: 800 },
  'gemini-2.5-pro': { tier: 'free', costPer1MInput: 1.25, costPer1MOutput: 10.00, averageLatencyMs: 1500 },
  'gemini-3-flash-preview': { tier: 'free', costPer1MInput: 0.50, costPer1MOutput: 3.00, averageLatencyMs: 1000 },
  'gemini-3-pro-preview': { tier: 'free', costPer1MInput: 2.00, costPer1MOutput: 12.00, averageLatencyMs: 2000 },

  // Free tier models (Groq)
  'llama-3.3-70b-versatile': { tier: 'free', costPer1MInput: 0.59, costPer1MOutput: 0.79, averageLatencyMs: 200 },
  'whisper-large-v3-turbo': { tier: 'free', costPer1MInput: 0.04, costPer1MOutput: 0.04, averageLatencyMs: 300 },
  'whisper-large-v3': { tier: 'free', costPer1MInput: 0.05, costPer1MOutput: 0.05, averageLatencyMs: 500 },

  // Freemium tier (DeepSeek - very cheap)
  'deepseek-chat': { tier: 'freemium', costPer1MInput: 0.14, costPer1MOutput: 0.28, averageLatencyMs: 1000 },
  'deepseek-reasoner': { tier: 'freemium', costPer1MInput: 0.55, costPer1MOutput: 2.19, averageLatencyMs: 2000 },
  'deepseek-v3.2': { tier: 'freemium', costPer1MInput: 0.27, costPer1MOutput: 1.10, averageLatencyMs: 1200 },

  // Free tier (Cloudflare Workers AI)
  '@cf/meta/llama-3.2-11b-vision-instruct': { tier: 'free', averageLatencyMs: 1000 },

  // Paid models (Anthropic Claude)
  'claude-sonnet-4-20250514': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00, averageLatencyMs: 2000 },
  'claude-opus-4-20241120': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 75.00, averageLatencyMs: 3000 },

  // Paid models (OpenAI)
  'gpt-4o': { tier: 'paid', costPer1MInput: 2.50, costPer1MOutput: 10.00, averageLatencyMs: 1200 },
  'gpt-4o-mini': { tier: 'paid', costPer1MInput: 0.15, costPer1MOutput: 0.60, averageLatencyMs: 800 },
  'o1': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 60.00, averageLatencyMs: 4000 },
  'whisper-1': { tier: 'paid', costPer1MInput: 6.00, costPer1MOutput: 6.00, averageLatencyMs: 1000 },

  // Paid models (Mistral)
  'ministral-8b-2512': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0.10, averageLatencyMs: 600 },
  'ministral-14b-2512': { tier: 'paid', costPer1MInput: 0.15, costPer1MOutput: 0.15, averageLatencyMs: 700 },
  'devstral-2': { tier: 'paid', costPer1MInput: 0.20, costPer1MOutput: 0.20, averageLatencyMs: 900 },
  'mistral-large-2512': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 6.00, averageLatencyMs: 1500 },
  'mistral-small-3.1-2503': { tier: 'paid', costPer1MInput: 0.20, costPer1MOutput: 0.60, averageLatencyMs: 800 },

  // Paid models (Together AI)
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 0.88, costPer1MOutput: 0.88, averageLatencyMs: 400 },
};

// Get capabilities for a model, with fallback to defaults
export function getModelCapabilities(modelId: string): ModelCapabilities {
  return MODEL_CAPABILITIES[modelId] || DEFAULT_CAPABILITIES;
}

// Get pricing for a model
export function getModelPricing(modelId: string): ModelPricing {
  return MODEL_PRICING[modelId] || { tier: 'freemium', averageLatencyMs: 1500 };
}
