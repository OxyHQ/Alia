/**
 * Model Mappings Generator
 *
 * This utility generates complete model mappings with capabilities and pricing
 */

import type { ModelMapping, AliaTier } from './alia-models';
import { getModelCapabilities, getModelPricing } from './model-capabilities-data';

// Helper to create a model mapping with all required fields
export function createMapping(
  provider: string,
  modelId: string,
  priority: number,
  qualityScore: number
): ModelMapping {
  const pricing = getModelPricing(modelId);
  const capabilities = getModelCapabilities(modelId);

  return {
    provider,
    modelId,
    priority,
    qualityScore,
    pricingTier: pricing.tier,
    costPer1MInput: pricing.costPer1MInput,
    costPer1MOutput: pricing.costPer1MOutput,
    averageLatencyMs: pricing.averageLatencyMs,
    capabilities,
  };
}

// Generate all tier mappings
export const GENERATED_TIER_MAPPINGS: Record<AliaTier, ModelMapping[]> = {
  'lite': [
    createMapping('google', 'gemini-2.5-flash', 1, 75),
    createMapping('groq', 'llama-3.3-70b-versatile', 2, 65),
    createMapping('groq', 'openai/gpt-oss-20b', 3, 68),
    createMapping('deepseek', 'deepseek-chat', 4, 72),
    createMapping('mistral', 'ministral-8b-2512', 5, 67),
    createMapping('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 6, 65),
  ],
  'v1': [
    createMapping('google', 'gemini-3-flash-preview', 1, 85),
    createMapping('deepseek', 'deepseek-chat', 2, 83),
    createMapping('groq', 'openai/gpt-oss-120b', 3, 82),
    createMapping('openai', 'gpt-4.1-mini', 4, 82),
    createMapping('mistral', 'ministral-14b-2512', 5, 78),
    createMapping('groq', 'llama-3.3-70b-versatile', 6, 70),
  ],
  'v1-codea': [
    createMapping('deepseek', 'deepseek-chat', 1, 94),
    createMapping('mistral', 'devstral-2', 2, 93),
    createMapping('groq', 'groq/compound', 3, 92),
    createMapping('anthropic', 'claude-sonnet-4.5', 4, 95),
    createMapping('google', 'gemini-3-pro', 5, 92),
    createMapping('openai', 'gpt-5.2-codex', 6, 93),
  ],
  'v1-cowork': [
    createMapping('deepseek', 'deepseek-chat', 1, 93),
    createMapping('anthropic', 'claude-sonnet-4.5', 2, 95),
    createMapping('google', 'gemini-3-pro', 3, 92),
    createMapping('openai', 'gpt-5.2-instant', 4, 90),
    createMapping('mistral', 'mistral-large-2512', 5, 89),
  ],
  'v1-browser': [
    createMapping('groq', 'groq/compound', 1, 95),
    createMapping('groq', 'openai/gpt-oss-120b', 2, 93),
    createMapping('google', 'gemini-3-pro', 3, 94),
    createMapping('deepseek', 'deepseek-v3.2', 4, 92),
    createMapping('cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 5, 89),
    createMapping('anthropic', 'claude-sonnet-4.5', 6, 96),
    createMapping('openai', 'gpt-5.2-instant', 7, 90),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 8, 86),
  ],
  'v1-vision': [
    createMapping('google', 'gemini-3-pro', 1, 96),
    createMapping('cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 2, 90),
    createMapping('anthropic', 'claude-sonnet-4.5', 3, 95),
    createMapping('openai', 'gpt-5.2-instant', 4, 92),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 5, 88),
    createMapping('mistral', 'mistral-small-3.1-2503', 6, 87),
  ],
  'v1-audio': [
    createMapping('groq', 'whisper-large-v3-turbo', 1, 95),
    createMapping('groq', 'whisper-large-v3', 2, 93),
    createMapping('openai', 'whisper-1', 3, 92),
    createMapping('google', 'gemini-2.5-flash-native-audio-preview-12-2025', 4, 90),
  ],
  'v1-multimodal': [
    createMapping('google', 'gemini-3-pro', 1, 98),
    createMapping('anthropic', 'claude-opus-4.5', 2, 97),
    createMapping('cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 3, 92),
    createMapping('openai', 'gpt-5.2-thinking', 4, 95),
    createMapping('mistral', 'mistral-large-2512', 5, 90),
  ],
  'v1-pro': [
    createMapping('deepseek', 'deepseek-reasoner', 1, 96),
    createMapping('anthropic', 'claude-sonnet-4.5', 2, 95),
    createMapping('openai', 'gpt-5.2-thinking', 3, 94),
    createMapping('google', 'gemini-3-pro', 4, 92),
    createMapping('mistral', 'mistral-large-2512', 5, 91),
  ],
  'v1-pro-max': [
    createMapping('anthropic', 'claude-opus-4.5', 1, 98),
    createMapping('openai', 'gpt-5.2-pro', 2, 96),
    createMapping('deepseek', 'deepseek-v3.2', 3, 95),
    createMapping('google', 'gemini-3-pro', 4, 94),
    createMapping('mistral', 'mistral-large-2512', 5, 92),
  ],
};
