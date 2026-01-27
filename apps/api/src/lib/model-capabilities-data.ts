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
  // ============== OPENAI ==============
  // Legacy models
  'ada': createCapabilities({ maxContextTokens: 2048, maxOutputTokens: 2048 }),
  'text-ada-001': createCapabilities({ maxContextTokens: 2048, maxOutputTokens: 2048 }),
  'babbage': createCapabilities({ maxContextTokens: 2048, maxOutputTokens: 2048 }),
  'curie': createCapabilities({ maxContextTokens: 2048, maxOutputTokens: 2048 }),
  'text-curie-001': createCapabilities({ maxContextTokens: 2048, maxOutputTokens: 2048 }),
  'davinci': createCapabilities({ maxContextTokens: 2048, maxOutputTokens: 2048 }),
  'text-davinci-001': createCapabilities({ maxContextTokens: 4096, maxOutputTokens: 4096 }),
  'text-davinci-002': createCapabilities({ maxContextTokens: 4096, maxOutputTokens: 4096 }),
  'text-davinci-003': createCapabilities({ maxContextTokens: 4096, maxOutputTokens: 4096 }),

  // GPT-3.5 series
  'gpt-3.5-turbo': createCapabilities({ maxContextTokens: 16385, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-0301': createCapabilities({ maxContextTokens: 4096, maxOutputTokens: 4096 }),
  'gpt-35-turbo': createCapabilities({ maxContextTokens: 16385, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-1106': createCapabilities({ maxContextTokens: 16385, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-0613': createCapabilities({ maxContextTokens: 4096, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-16k-0613': createCapabilities({ maxContextTokens: 16384, maxOutputTokens: 4096 }),
  'gpt-35-turbo-16k': createCapabilities({ maxContextTokens: 16384, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-0125': createCapabilities({ maxContextTokens: 16385, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-instruct': createCapabilities({ maxContextTokens: 8192, maxOutputTokens: 4096 }),
  'gpt-3.5-turbo-instruct-0914': createCapabilities({ maxContextTokens: 8192, maxOutputTokens: 4096 }),

  // GPT-4 series
  'gpt-4': createCapabilities({ maxContextTokens: 8192, maxOutputTokens: 8192 }),
  'gpt-4-0314': createCapabilities({ maxContextTokens: 8192, maxOutputTokens: 8192 }),
  'gpt-4-0613': createCapabilities({ maxContextTokens: 8192, maxOutputTokens: 8192 }),
  'gpt-4-32k': createCapabilities({ maxContextTokens: 32768, maxOutputTokens: 8192 }),
  'gpt-4-32k-0314': createCapabilities({ maxContextTokens: 32768, maxOutputTokens: 8192 }),
  'gpt-4-32k-0613': createCapabilities({ maxContextTokens: 32768, maxOutputTokens: 8192 }),
  'gpt-4-0125-preview': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'gpt-4-1106-preview': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'gpt-4-1106-vision-preview': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'gpt-4-vision-preview': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'gpt-4-turbo': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'gpt-4-turbo-2024-04-09': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'gpt-4-turbo-0125-preview': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 4096 }),

  // GPT-4o series
  'gpt-4o': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-2024-05-13': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-2024-08-06': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-2024-11-20': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-mini': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-mini-2024-07-18': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-realtime': createCapabilities({ vision: true, audio: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-mini-realtime': createCapabilities({ vision: true, audio: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-audio-preview': createCapabilities({ vision: true, audio: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4o-search-preview': createCapabilities({ vision: true, webSearch: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'chatgpt-4o-latest': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),

  // O-series (reasoning models)
  'o1': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 100000 }),
  'o1-preview': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 32768 }),
  'o1-preview-2024-09-12': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 32768 }),
  'o1-mini': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 65536 }),
  'o1-mini-2024-09-12': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 65536 }),
  'o1-2024-12-17': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 100000 }),
  'o1-pro': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 100000 }),
  'o3-mini': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 65536 }),
  'o3-mini-2025-01-31': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 65536 }),
  'o3-2025-04-16': createCapabilities({ maxContextTokens: 200000, maxOutputTokens: 100000 }),
  'o3-pro': createCapabilities({ maxContextTokens: 200000, maxOutputTokens: 100000 }),
  'o4-mini': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 65536 }),
  'o4-mini-2025-04-16': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 65536 }),

  // GPT-4.1 series
  'gpt-4.1': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4.1-2025-04-14': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4.1-mini': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4.1-mini-2025-04-14': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4.1-nano': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-4.1-nano-2025-04-14': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 16384 }),

  // GPT-5 series
  'gpt-5': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5-2025-08-07': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5-mini': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5-mini-2025-08-07': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5-nano': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5-nano-2025-08-07': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5-chat-latest': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.1': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.1-codex': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.1-codex-mini': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.1-chat-latest': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.2': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.2-2025-12-11': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.2-pro': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'gpt-5.2-chat-latest': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),
  'codex-mini-latest': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 16384 }),
  'gpt-5-codex': createCapabilities({ vision: true, maxContextTokens: 256000, maxOutputTokens: 32768 }),

  // Embeddings
  'text-embedding-ada-002': createCapabilities({ tools: false, functionCalling: false, maxContextTokens: 8191, maxOutputTokens: 8191 }),
  'text-embedding-ada': createCapabilities({ tools: false, functionCalling: false, maxContextTokens: 8191, maxOutputTokens: 8191 }),
  'text-embedding-ada-002-v2': createCapabilities({ tools: false, functionCalling: false, maxContextTokens: 8191, maxOutputTokens: 8191 }),
  'text-embedding-3-small': createCapabilities({ tools: false, functionCalling: false, maxContextTokens: 8191, maxOutputTokens: 8191 }),
  'text-embedding-3-large': createCapabilities({ tools: false, functionCalling: false, maxContextTokens: 8191, maxOutputTokens: 8191 }),

  // Audio
  'whisper-1': createCapabilities({ audio: true, tools: false, functionCalling: false, maxContextTokens: 4096, maxOutputTokens: 4096 }),

  // ============== ANTHROPIC CLAUDE ==============
  'claude-instant-1': createCapabilities({ maxContextTokens: 100000, maxOutputTokens: 8192 }),
  'claude-instant-1.2': createCapabilities({ maxContextTokens: 100000, maxOutputTokens: 8192 }),
  'claude-v1': createCapabilities({ maxContextTokens: 100000, maxOutputTokens: 8192 }),
  'claude-2': createCapabilities({ maxContextTokens: 100000, maxOutputTokens: 8192 }),
  'claude-2.0': createCapabilities({ maxContextTokens: 100000, maxOutputTokens: 8192 }),

  // Claude 3 series
  'claude-3-opus-20240229': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 4096 }),
  'claude-3-sonnet-20240229': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 4096 }),
  'claude-3-haiku-20240307': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 4096 }),
  'claude-3-5-sonnet-20240620': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-3-5-sonnet-20241022': createCapabilities({ vision: true, computerUse: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-3-5-haiku-20241022': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-3-7-sonnet-20250219': createCapabilities({ vision: true, computerUse: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),

  // Claude 4 series
  'claude-sonnet-4-20250514': createCapabilities({ vision: true, computerUse: true, promptCaching: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-haiku-4-5-20251001': createCapabilities({ vision: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-sonnet-4-5-20250929': createCapabilities({ vision: true, computerUse: true, promptCaching: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-opus-4-20250514': createCapabilities({ vision: true, computerUse: true, promptCaching: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-opus-4-20241120': createCapabilities({ vision: true, computerUse: true, promptCaching: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-opus-4-1-20250805': createCapabilities({ vision: true, computerUse: true, promptCaching: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),
  'claude-opus-4-5': createCapabilities({ vision: true, computerUse: true, promptCaching: true, maxContextTokens: 200000, maxOutputTokens: 8192 }),

  // ============== LLAMA ==============
  'Llama-4-Maverick-17B-128E-Instruct-FP8': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'Llama-4-Scout-17B-16E-Instruct-FP8': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'Llama-3.3-70B-Instruct': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'Llama-3.3-8B-Instruct': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),

  // ============== GOOGLE GEMINI ==============
  'gemini-pro': createCapabilities({ maxContextTokens: 32000, maxOutputTokens: 8192 }),
  'gemini-1.0-pro': createCapabilities({ maxContextTokens: 32000, maxOutputTokens: 8192 }),
  'gemini-1.0-pro-vision-001': createCapabilities({ vision: true, maxContextTokens: 32000, maxOutputTokens: 8192 }),
  'gemini-1.5-flash': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-flash-1.5-8b': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-1.5-pro': createCapabilities({ vision: true, maxContextTokens: 2000000, maxOutputTokens: 8192 }),
  'gemini-2.0-flash': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.0-flash-lite': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-flash': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-flash-preview': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-flash-lite-preview-06-17': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-flash-lite': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-flash-preview-image': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-flash-image': createCapabilities({ vision: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-2.5-pro': createCapabilities({ vision: true, maxContextTokens: 2000000, maxOutputTokens: 8192, promptCaching: true }),
  'gemini-2.5-pro-preview': createCapabilities({ vision: true, maxContextTokens: 2000000, maxOutputTokens: 8192, promptCaching: true }),
  'gemini-2.5-pro-exp-03-25': createCapabilities({ vision: true, maxContextTokens: 2000000, maxOutputTokens: 8192, promptCaching: true }),
  'gemini-3-flash-preview': createCapabilities({ vision: true, codeExecution: true, webSearch: true, maxContextTokens: 1000000, maxOutputTokens: 8192 }),
  'gemini-3-pro-preview': createCapabilities({ vision: true, codeExecution: true, webSearch: true, maxContextTokens: 1000000, maxOutputTokens: 64000, promptCaching: true }),

  // ============== X (GROK) ==============
  'grok-beta': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-vision-beta': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-2-1212': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-2-vision-1212': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-code-fast-1': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-4-fast': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-4': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-3-mini': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'grok-3': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),

  // ============== DEEPSEEK ==============
  'deepseek-chat': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'deepseek-reasoner': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'deepseek-v3': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'deepseek-v3.1': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'deepseek-v3.2': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'deepseek-ai/deepseek-coder-33b-instruct': createCapabilities({ maxContextTokens: 16000, maxOutputTokens: 8192 }),
  'deepseek-ai/DeepSeek-V3': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'deepseek-ai/DeepSeek-R1': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),

  // ============== MISTRAL ==============
  'ministral-8b-2512': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'ministral-14b-2512': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'devstral-2': createCapabilities({ maxContextTokens: 256000, maxOutputTokens: 8192 }),
  'mistral-large-2512': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'mistral-small-3.1-2503': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'mistral-medium-3.1': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'codestral-2508': createCapabilities({ maxContextTokens: 256000, maxOutputTokens: 8192 }),
  'devstral-medium': createCapabilities({ maxContextTokens: 256000, maxOutputTokens: 8192 }),
  'devstral-small': createCapabilities({ maxContextTokens: 256000, maxOutputTokens: 8192 }),

  // ============== GROQ ==============
  'llama-3.3-70b-versatile': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'openai/gpt-oss-20b': createCapabilities({ codeExecution: true, webSearch: true, maxContextTokens: 128000, maxOutputTokens: 4096 }),
  'openai/gpt-oss-120b': createCapabilities({ codeExecution: true, webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'groq/compound': createCapabilities({ codeExecution: true, webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'whisper-large-v3-turbo': createCapabilities({ audio: true, tools: false, functionCalling: false, maxContextTokens: 4096, maxOutputTokens: 4096 }),
  'whisper-large-v3': createCapabilities({ audio: true, tools: false, functionCalling: false, maxContextTokens: 4096, maxOutputTokens: 4096 }),

  // ============== PERPLEXITY ==============
  'sonar': createCapabilities({ webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'sonar-pro': createCapabilities({ webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'sonar-reasoning': createCapabilities({ webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'sonar-reasoning-pro': createCapabilities({ webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'sonar-deep-research': createCapabilities({ webSearch: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),

  // ============== TOGETHER AI ==============
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'meta-llama/Llama-4-Scout-17B-16E-Instruct': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'Qwen/Qwen2.5-7B-Instruct-Turbo': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'Qwen/Qwen2.5-72B-Instruct-Turbo': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'Qwen/Qwen2.5-Coder-32B-Instruct': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'mistralai/Mixtral-8x7B-Instruct-v0.1': createCapabilities({ maxContextTokens: 32000, maxOutputTokens: 8192 }),
  'mistralai/Mixtral-8x22B-Instruct-v0.1': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),

  // ============== FIREWORKS ==============
  'accounts/fireworks/models/mixtral-8x7b-instruct': createCapabilities({ maxContextTokens: 32000, maxOutputTokens: 8192 }),
  'accounts/fireworks/models/mixtral-8x22b-instruct': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),
  'accounts/fireworks/models/llama-v3p1-405b-instruct': createCapabilities({ maxContextTokens: 128000, maxOutputTokens: 8192 }),
  'accounts/fireworks/models/deepseek-v3': createCapabilities({ maxContextTokens: 64000, maxOutputTokens: 8192 }),

  // ============== CLOUDFLARE ==============
  '@cf/meta/llama-3.2-11b-vision-instruct': createCapabilities({ vision: true, maxContextTokens: 128000, maxOutputTokens: 8192 }),
};

// ============== PRICING DATABASE ==============

export interface ModelPricing {
  tier: PricingTier;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  averageLatencyMs?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ============== OPENAI ==============
  // Legacy models
  'ada': { tier: 'paid', costPer1MInput: 0.40, costPer1MOutput: 0.40 },
  'text-ada-001': { tier: 'paid', costPer1MInput: 0.40, costPer1MOutput: 0.40 },
  'babbage': { tier: 'paid', costPer1MInput: 0.50, costPer1MOutput: 0.50 },
  'curie': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 2.00 },
  'text-curie-001': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 2.00 },
  'davinci': { tier: 'paid', costPer1MInput: 20.00, costPer1MOutput: 20.00 },
  'text-davinci-001': { tier: 'paid', costPer1MInput: 20.00, costPer1MOutput: 20.00 },
  'text-davinci-002': { tier: 'paid', costPer1MInput: 20.00, costPer1MOutput: 20.00 },
  'text-davinci-003': { tier: 'paid', costPer1MInput: 20.00, costPer1MOutput: 20.00 },

  // GPT-3.5 series
  'gpt-3.5-turbo': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 2.00 },
  'gpt-3.5-turbo-0301': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 2.00 },
  'gpt-35-turbo': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 2.00 },
  'gpt-3.5-turbo-1106': { tier: 'paid', costPer1MInput: 1.00, costPer1MOutput: 2.00 },
  'gpt-3.5-turbo-instruct': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 2.00 },
  'gpt-3.5-turbo-instruct-0914': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 2.00 },
  'gpt-3.5-turbo-0613': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 2.00 },
  'gpt-35-turbo-16k': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 4.00 },
  'gpt-3.5-turbo-16k-0613': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 4.00 },
  'gpt-3.5-turbo-0125': { tier: 'paid', costPer1MInput: 0.50, costPer1MOutput: 1.50 },

  // GPT-4 series
  'gpt-4': { tier: 'paid', costPer1MInput: 30.00, costPer1MOutput: 60.00 },
  'gpt-4-0314': { tier: 'paid', costPer1MInput: 30.00, costPer1MOutput: 60.00 },
  'gpt-4-0613': { tier: 'paid', costPer1MInput: 30.00, costPer1MOutput: 60.00 },
  'gpt-4-32k': { tier: 'paid', costPer1MInput: 60.00, costPer1MOutput: 120.00 },
  'gpt-4-32k-0314': { tier: 'paid', costPer1MInput: 60.00, costPer1MOutput: 120.00 },
  'gpt-4-32k-0613': { tier: 'paid', costPer1MInput: 60.00, costPer1MOutput: 120.00 },
  'gpt-4-0125-preview': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gpt-4-1106-preview': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gpt-4-1106-vision-preview': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gpt-4-vision-preview': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gpt-4-turbo': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gpt-4-turbo-2024-04-09': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gpt-4-turbo-0125-preview': { tier: 'paid', costPer1MInput: 10.00, costPer1MOutput: 30.00 },

  // GPT-4o series
  'gpt-4o': { tier: 'paid', costPer1MInput: 2.50, costPer1MOutput: 10.00, averageLatencyMs: 1200 },
  'gpt-4o-2024-05-13': { tier: 'paid', costPer1MInput: 5.00, costPer1MOutput: 15.00 },
  'gpt-4o-2024-08-06': { tier: 'paid', costPer1MInput: 2.50, costPer1MOutput: 10.00 },
  'gpt-4o-2024-11-20': { tier: 'paid', costPer1MInput: 2.50, costPer1MOutput: 10.00 },
  'gpt-4o-mini': { tier: 'paid', costPer1MInput: 0.15, costPer1MOutput: 0.60, averageLatencyMs: 800 },
  'gpt-4o-mini-2024-07-18': { tier: 'paid', costPer1MInput: 0.15, costPer1MOutput: 0.60 },
  'gpt-4o-realtime': { tier: 'paid', costPer1MInput: 4.00, costPer1MOutput: 16.00 },
  'gpt-4o-mini-realtime': { tier: 'paid', costPer1MInput: 0.60, costPer1MOutput: 2.40 },
  'gpt-4o-audio-preview': { tier: 'paid', costPer1MInput: 2.50, costPer1MOutput: 10.00 },
  'gpt-4o-search-preview': { tier: 'paid', costPer1MInput: 2.50, costPer1MOutput: 10.00 },
  'chatgpt-4o-latest': { tier: 'paid', costPer1MInput: 5.00, costPer1MOutput: 15.00 },

  // O-series (reasoning models)
  'o1': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 60.00, averageLatencyMs: 4000 },
  'o1-preview': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 60.00 },
  'o1-preview-2024-09-12': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 60.00 },
  'o1-mini': { tier: 'paid', costPer1MInput: 1.10, costPer1MOutput: 4.40 },
  'o1-mini-2024-09-12': { tier: 'paid', costPer1MInput: 1.10, costPer1MOutput: 4.40 },
  'o1-2024-12-17': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 60.00 },
  'o1-pro': { tier: 'paid', costPer1MInput: 150.00, costPer1MOutput: 600.00 },
  'o3-mini': { tier: 'paid', costPer1MInput: 1.10, costPer1MOutput: 4.40 },
  'o3-mini-2025-01-31': { tier: 'paid', costPer1MInput: 1.10, costPer1MOutput: 4.40 },
  'o3-2025-04-16': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 8.00 },
  'o3-pro': { tier: 'paid', costPer1MInput: 20.00, costPer1MOutput: 80.00 },
  'o4-mini': { tier: 'paid', costPer1MInput: 1.10, costPer1MOutput: 4.40 },
  'o4-mini-2025-04-16': { tier: 'paid', costPer1MInput: 1.10, costPer1MOutput: 4.40 },

  // GPT-4.1 series
  'gpt-4.1': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 8.00 },
  'gpt-4.1-2025-04-14': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 8.00 },
  'gpt-4.1-mini': { tier: 'paid', costPer1MInput: 0.40, costPer1MOutput: 1.60 },
  'gpt-4.1-mini-2025-04-14': { tier: 'paid', costPer1MInput: 0.40, costPer1MOutput: 1.60 },
  'gpt-4.1-nano': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0.40 },
  'gpt-4.1-nano-2025-04-14': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0.40 },

  // GPT-5 series
  'gpt-5': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gpt-5-2025-08-07': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gpt-5-mini': { tier: 'paid', costPer1MInput: 0.25, costPer1MOutput: 2.00 },
  'gpt-5-mini-2025-08-07': { tier: 'paid', costPer1MInput: 0.25, costPer1MOutput: 2.00 },
  'gpt-5-nano': { tier: 'paid', costPer1MInput: 0.05, costPer1MOutput: 0.40 },
  'gpt-5-nano-2025-08-07': { tier: 'paid', costPer1MInput: 0.05, costPer1MOutput: 0.40 },
  'gpt-5-chat-latest': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gpt-5.1': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gpt-5.1-codex': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gpt-5.1-codex-mini': { tier: 'paid', costPer1MInput: 0.25, costPer1MOutput: 2.00 },
  'gpt-5.1-chat-latest': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gpt-5.2': { tier: 'paid', costPer1MInput: 1.75, costPer1MOutput: 14.00 },
  'gpt-5.2-2025-12-11': { tier: 'paid', costPer1MInput: 1.75, costPer1MOutput: 14.00 },
  'gpt-5.2-pro': { tier: 'paid', costPer1MInput: 21.00, costPer1MOutput: 168.00 },
  'gpt-5.2-chat-latest': { tier: 'paid', costPer1MInput: 1.75, costPer1MOutput: 14.00 },
  'codex-mini-latest': { tier: 'paid', costPer1MInput: 1.50, costPer1MOutput: 6.00 },
  'gpt-5-codex': { tier: 'paid', costPer1MInput: 1.25, costPer1MOutput: 10.00 },

  // Embeddings
  'text-embedding-ada-002': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0 },
  'text-embedding-ada': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0 },
  'text-embedding-ada-002-v2': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0 },
  'text-embedding-3-small': { tier: 'paid', costPer1MInput: 0.02, costPer1MOutput: 0 },
  'text-embedding-3-large': { tier: 'paid', costPer1MInput: 0.13, costPer1MOutput: 0 },

  // Audio
  'whisper-1': { tier: 'paid', costPer1MInput: 6.00, costPer1MOutput: 6.00, averageLatencyMs: 1000 },

  // ============== ANTHROPIC CLAUDE ==============
  'claude-instant-1': { tier: 'paid', costPer1MInput: 1.63, costPer1MOutput: 55.10 },
  'claude-instant-1.2': { tier: 'paid', costPer1MInput: 1.63, costPer1MOutput: 5.51 },
  'claude-v1': { tier: 'paid', costPer1MInput: 8.00, costPer1MOutput: 24.00 },
  'claude-2': { tier: 'paid', costPer1MInput: 8.00, costPer1MOutput: 24.00 },
  'claude-2.0': { tier: 'paid', costPer1MInput: 11.02, costPer1MOutput: 32.68 },

  // Claude 3 series
  'claude-3-opus-20240229': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 75.00 },
  'claude-3-sonnet-20240229': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'claude-3-haiku-20240307': { tier: 'paid', costPer1MInput: 0.25, costPer1MOutput: 1.25 },
  'claude-3-5-sonnet-20240620': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'claude-3-5-sonnet-20241022': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'claude-3-5-haiku-20241022': { tier: 'paid', costPer1MInput: 0.80, costPer1MOutput: 4.00 },
  'claude-3-7-sonnet-20250219': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },

  // Claude 4 series
  'claude-sonnet-4-20250514': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00, averageLatencyMs: 2000 },
  'claude-haiku-4-5-20251001': { tier: 'paid', costPer1MInput: 1.00, costPer1MOutput: 5.00 },
  'claude-sonnet-4-5-20250929': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'claude-opus-4-20250514': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 75.00 },
  'claude-opus-4-20241120': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 75.00, averageLatencyMs: 3000 },
  'claude-opus-4-1-20250805': { tier: 'paid', costPer1MInput: 15.00, costPer1MOutput: 75.00 },
  'claude-opus-4-5': { tier: 'paid', costPer1MInput: 5.00, costPer1MOutput: 25.00 },

  // ============== LLAMA ==============
  'Llama-4-Maverick-17B-128E-Instruct-FP8': { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0 },
  'Llama-4-Scout-17B-16E-Instruct-FP8': { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0 },
  'Llama-3.3-70B-Instruct': { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0 },
  'Llama-3.3-8B-Instruct': { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0 },

  // ============== GOOGLE GEMINI ==============
  'gemini-pro': { tier: 'free', costPer1MInput: 0.125, costPer1MOutput: 0.375 },
  'gemini-1.0-pro': { tier: 'free', costPer1MInput: 0.125, costPer1MOutput: 0.375 },
  'gemini-1.0-pro-vision-001': { tier: 'free', costPer1MInput: 0.125, costPer1MOutput: 0.375 },
  'gemini-1.5-flash': { tier: 'free', costPer1MInput: 0.35, costPer1MOutput: 1.05 },
  'gemini-flash-1.5-8b': { tier: 'free', costPer1MInput: 0.0375, costPer1MOutput: 0.15 },
  'gemini-1.5-pro': { tier: 'free', costPer1MInput: 3.50, costPer1MOutput: 10.50 },
  'gemini-2.0-flash': { tier: 'free', costPer1MInput: 0.10, costPer1MOutput: 0.40 },
  'gemini-2.0-flash-lite': { tier: 'free', costPer1MInput: 0.10, costPer1MOutput: 0.40 },
  'gemini-2.5-flash': { tier: 'free', costPer1MInput: 0.30, costPer1MOutput: 2.50, averageLatencyMs: 800 },
  'gemini-2.5-flash-preview': { tier: 'free', costPer1MInput: 0.15, costPer1MOutput: 0.60 },
  'gemini-2.5-flash-lite-preview-06-17': { tier: 'free', costPer1MInput: 0.10, costPer1MOutput: 0.40 },
  'gemini-2.5-flash-lite': { tier: 'free', costPer1MInput: 0.10, costPer1MOutput: 0.40 },
  'gemini-2.5-flash-preview-image': { tier: 'free', costPer1MInput: 0.30, costPer1MOutput: 2.50 },
  'gemini-2.5-flash-image': { tier: 'free', costPer1MInput: 0.30, costPer1MOutput: 2.50 },
  'gemini-2.5-pro': { tier: 'free', costPer1MInput: 1.25, costPer1MOutput: 10.00, averageLatencyMs: 1500 },
  'gemini-2.5-pro-preview': { tier: 'free', costPer1MInput: 1.25, costPer1MOutput: 10.00 },
  'gemini-2.5-pro-exp-03-25': { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0 },
  'gemini-3-flash-preview': { tier: 'free', costPer1MInput: 0.50, costPer1MOutput: 3.00, averageLatencyMs: 1000 },
  'gemini-3-pro-preview': { tier: 'free', costPer1MInput: 2.00, costPer1MOutput: 12.00, averageLatencyMs: 2000 },

  // ============== X (GROK) ==============
  'grok-beta': { tier: 'paid', costPer1MInput: 5.00, costPer1MOutput: 15.00 },
  'grok-vision-beta': { tier: 'paid', costPer1MInput: 5.00, costPer1MOutput: 15.00 },
  'grok-2-1212': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 10.00 },
  'grok-2-vision-1212': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 10.00 },
  'grok-code-fast-1': { tier: 'paid', costPer1MInput: 0.20, costPer1MOutput: 1.50 },
  'grok-4-fast': { tier: 'paid', costPer1MInput: 0.20, costPer1MOutput: 0.50 },
  'grok-4': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'grok-3-mini': { tier: 'paid', costPer1MInput: 0.30, costPer1MOutput: 0.50 },
  'grok-3': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },

  // ============== DEEPSEEK ==============
  'deepseek-chat': { tier: 'freemium', costPer1MInput: 0.27, costPer1MOutput: 1.00, averageLatencyMs: 1000 },
  'deepseek-reasoner': { tier: 'freemium', costPer1MInput: 0.55, costPer1MOutput: 2.19, averageLatencyMs: 2000 },
  'deepseek-v3': { tier: 'freemium', costPer1MInput: 1.25, costPer1MOutput: 1.25 },
  'deepseek-v3.1': { tier: 'freemium', costPer1MInput: 0.27, costPer1MOutput: 1.00 },
  'deepseek-v3.2': { tier: 'freemium', costPer1MInput: 0.27, costPer1MOutput: 0.40, averageLatencyMs: 1200 },
  'deepseek-ai/deepseek-coder-33b-instruct': { tier: 'freemium', costPer1MInput: 0.80, costPer1MOutput: 0.80 },
  'deepseek-ai/DeepSeek-V3': { tier: 'freemium', costPer1MInput: 1.25, costPer1MOutput: 1.25 },
  'deepseek-ai/DeepSeek-R1': { tier: 'freemium', costPer1MInput: 3.00, costPer1MOutput: 7.00 },

  // ============== MISTRAL ==============
  'ministral-8b-2512': { tier: 'paid', costPer1MInput: 0.10, costPer1MOutput: 0.10, averageLatencyMs: 600 },
  'ministral-14b-2512': { tier: 'paid', costPer1MInput: 0.15, costPer1MOutput: 0.15, averageLatencyMs: 700 },
  'devstral-2': { tier: 'paid', costPer1MInput: 0.20, costPer1MOutput: 0.20, averageLatencyMs: 900 },
  'mistral-large-2512': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 6.00, averageLatencyMs: 1500 },
  'mistral-small-3.1-2503': { tier: 'paid', costPer1MInput: 0.20, costPer1MOutput: 0.60, averageLatencyMs: 800 },
  'mistral-medium-3.1': { tier: 'paid', costPer1MInput: 0.40, costPer1MOutput: 2.00 },
  'codestral-2508': { tier: 'paid', costPer1MInput: 0.30, costPer1MOutput: 0.90 },
  'devstral-medium': { tier: 'paid', costPer1MInput: 0.40, costPer1MOutput: 2.00 },
  'devstral-small': { tier: 'paid', costPer1MInput: 0.07, costPer1MOutput: 0.28 },

  // ============== GROQ ==============
  'llama-3.3-70b-versatile': { tier: 'free', costPer1MInput: 0.59, costPer1MOutput: 0.79, averageLatencyMs: 200 },
  'openai/gpt-oss-20b': { tier: 'free', costPer1MInput: 0.03, costPer1MOutput: 0.14 },
  'openai/gpt-oss-120b': { tier: 'free', costPer1MInput: 0.04, costPer1MOutput: 0.40 },
  'groq/compound': { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0 },
  'whisper-large-v3-turbo': { tier: 'free', costPer1MInput: 0.04, costPer1MOutput: 0.04, averageLatencyMs: 300 },
  'whisper-large-v3': { tier: 'free', costPer1MInput: 0.05, costPer1MOutput: 0.05, averageLatencyMs: 500 },

  // ============== PERPLEXITY ==============
  'sonar': { tier: 'paid', costPer1MInput: 1.00, costPer1MOutput: 1.00 },
  'sonar-pro': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'sonar-reasoning': { tier: 'paid', costPer1MInput: 1.00, costPer1MOutput: 5.00 },
  'sonar-reasoning-pro': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 8.00 },
  'sonar-deep-research': { tier: 'paid', costPer1MInput: 2.00, costPer1MOutput: 8.00 },

  // ============== TOGETHER AI ==============
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 0.88, costPer1MOutput: 0.88, averageLatencyMs: 400 },
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 0.18, costPer1MOutput: 0.18 },
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 0.88, costPer1MOutput: 0.88 },
  'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 3.50, costPer1MOutput: 3.50 },
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8': { tier: 'paid', costPer1MInput: 0.27, costPer1MOutput: 0.85 },
  'meta-llama/Llama-4-Scout-17B-16E-Instruct': { tier: 'paid', costPer1MInput: 0.18, costPer1MOutput: 0.59 },
  'Qwen/Qwen2.5-7B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 0.30, costPer1MOutput: 0.30 },
  'Qwen/Qwen2.5-72B-Instruct-Turbo': { tier: 'paid', costPer1MInput: 1.20, costPer1MOutput: 1.20 },
  'Qwen/Qwen2.5-Coder-32B-Instruct': { tier: 'paid', costPer1MInput: 0.80, costPer1MOutput: 0.80 },
  'mistralai/Mixtral-8x7B-Instruct-v0.1': { tier: 'paid', costPer1MInput: 0.90, costPer1MOutput: 0.90 },
  'mistralai/Mixtral-8x22B-Instruct-v0.1': { tier: 'paid', costPer1MInput: 2.40, costPer1MOutput: 2.40 },

  // ============== FIREWORKS ==============
  'accounts/fireworks/models/mixtral-8x7b-instruct': { tier: 'paid', costPer1MInput: 0.50, costPer1MOutput: 0.50 },
  'accounts/fireworks/models/mixtral-8x22b-instruct': { tier: 'paid', costPer1MInput: 1.20, costPer1MOutput: 1.20 },
  'accounts/fireworks/models/llama-v3p1-405b-instruct': { tier: 'paid', costPer1MInput: 3.00, costPer1MOutput: 3.00 },
  'accounts/fireworks/models/deepseek-v3': { tier: 'paid', costPer1MInput: 0.90, costPer1MOutput: 0.90 },

  // ============== CLOUDFLARE ==============
  '@cf/meta/llama-3.2-11b-vision-instruct': { tier: 'free', averageLatencyMs: 1000 },
};

// Get capabilities for a model, with fallback to defaults
export function getModelCapabilities(modelId: string): ModelCapabilities {
  return MODEL_CAPABILITIES[modelId] || DEFAULT_CAPABILITIES;
}

// Get pricing for a model
export function getModelPricing(modelId: string): ModelPricing {
  return MODEL_PRICING[modelId] || { tier: 'freemium', averageLatencyMs: 1500 };
}
