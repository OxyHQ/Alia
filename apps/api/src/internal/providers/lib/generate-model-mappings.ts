/**
 * Model Mappings Generator
 *
 * This utility generates complete model mappings with capabilities and pricing
 * IMPORTANT: Only use REAL, currently available model IDs
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

// Generate all tier mappings - ONLY REAL MODEL IDS
export const GENERATED_TIER_MAPPINGS: Record<AliaTier, ModelMapping[]> = {
  'lite': [
    createMapping('google', 'gemini-2.5-flash', 1, 75),
    createMapping('groq', 'llama-3.3-70b-versatile', 2, 65),
    createMapping('deepseek', 'deepseek-chat', 3, 72),
    createMapping('openai', 'gpt-4o-mini', 4, 68),
  ],
  'v1': [
    createMapping('google', 'gemini-2.5-flash', 1, 88),
    createMapping('google', 'gemini-3-flash-preview', 2, 85),
    createMapping('deepseek', 'deepseek-chat', 3, 83),
    createMapping('groq', 'llama-3.3-70b-versatile', 4, 80),
    createMapping('openai', 'gpt-4o-mini', 5, 82),
  ],
  'v1-codea': [
    createMapping('deepseek', 'deepseek-chat', 1, 94),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 2, 95),
    createMapping('google', 'gemini-3-flash-preview', 3, 93),
    createMapping('groq', 'llama-3.3-70b-versatile', 4, 90),
    createMapping('google', 'gemini-2.5-pro', 5, 92),
    createMapping('openai', 'gpt-4o', 6, 91),
  ],
  'v1-cowork': [
    createMapping('deepseek', 'deepseek-chat', 1, 93),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 2, 95),
    createMapping('google', 'gemini-2.5-pro', 3, 92),
    createMapping('openai', 'gpt-4o', 4, 90),
    createMapping('groq', 'llama-3.3-70b-versatile', 5, 87),
  ],
  'v1-browser': [
    createMapping('google', 'gemini-3-flash-preview', 1, 97),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 2, 96),
    createMapping('google', 'gemini-2.5-pro', 3, 94),
    createMapping('deepseek', 'deepseek-chat', 4, 92),
    createMapping('groq', 'llama-3.3-70b-versatile', 5, 89),
    createMapping('openai', 'gpt-4o', 6, 90),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 7, 86),
  ],
  'v1-vision': [
    createMapping('google', 'gemini-3-flash-preview', 1, 97),
    createMapping('google', 'gemini-2.5-pro', 2, 96),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 3, 95),
    createMapping('openai', 'gpt-4o', 4, 92),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 5, 88),
  ],
  'v1-audio': [
    createMapping('groq', 'whisper-large-v3-turbo', 1, 95),
    createMapping('groq', 'whisper-large-v3', 2, 93),
    createMapping('openai', 'whisper-1', 3, 92),
  ],
  'v1-multimodal': [
    createMapping('google', 'gemini-3-pro-preview', 1, 99),
    createMapping('google', 'gemini-2.5-pro', 2, 98),
    createMapping('anthropic', 'claude-opus-4-20241120', 3, 97),
    createMapping('google', 'gemini-3-flash-preview', 4, 96),
    createMapping('openai', 'gpt-4o', 5, 95),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 6, 90),
  ],
  'v1-pro': [
    createMapping('anthropic', 'claude-sonnet-4-20250514', 1, 96),
    createMapping('google', 'gemini-2.5-pro', 2, 95),
    createMapping('deepseek', 'deepseek-reasoner', 3, 94),
    createMapping('openai', 'o1', 4, 92),
  ],
  'v1-pro-max': [
    createMapping('anthropic', 'claude-opus-4-20241120', 1, 98),
    createMapping('google', 'gemini-2.5-pro', 2, 96),
    createMapping('openai', 'o1', 3, 95),
    createMapping('deepseek', 'deepseek-reasoner', 4, 94),
  ],
  'v1-voice': [
    {
      provider: 'xai',
      modelId: 'grok-realtime',
      priority: 1,
      qualityScore: 85,
      pricingTier: 'paid' as const,
      costPerMinute: 0.05,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
    },
    {
      provider: 'openai',
      modelId: 'gpt-4o-realtime-preview',
      priority: 2,
      qualityScore: 90,
      pricingTier: 'paid' as const,
      costPerMinute: 0.06,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
    },
  ],
  'v1-voice-pro': [
    {
      provider: 'openai',
      modelId: 'gpt-4o-realtime-preview',
      priority: 1,
      qualityScore: 90,
      pricingTier: 'paid' as const,
      costPerMinute: 0.06,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
    },
    {
      provider: 'xai',
      modelId: 'grok-realtime',
      priority: 2,
      qualityScore: 85,
      pricingTier: 'paid' as const,
      costPerMinute: 0.05,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
    },
  ],
};
