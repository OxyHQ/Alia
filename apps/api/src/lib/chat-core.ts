/**
 * Chat Core - Shared logic for all chat endpoints
 *
 * Provides model resolution via internal providers module,
 * AI SDK model creation, and health reporting.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { log } from './logger.js';

import {
  resolveAliaModel as internalResolveAliaModel,
  getDefaultAliaModel,
  isAliaModel,
  getAliaModel,
  getAllAliaModels,
  getAliaModelsByCategory,
  getDefaultModelForCategory,
  getAvailableModels,
  reportModelUsage as reportToProvidersAPI,
  type KeyConfig,
  type AliaModel,
  type AliaModelWithAvailability,
  type ModelCategory,
} from './providers-client.js';

// Re-export types and helpers that chat routes need
export { getDefaultAliaModel, isAliaModel, getAliaModel, getAllAliaModels, getAliaModelsByCategory, getDefaultModelForCategory, getAvailableModels };
export type { KeyConfig, AliaModel, AliaModelWithAvailability, ModelCategory };

/**
 * Result of resolving an Alia model to a concrete provider/model.
 * Compatible with the shape that chat routes already expect.
 */
export interface ResolvedModel {
  aliasModelId: string;
  provider: string;
  modelId: string;
  keyConfig: KeyConfig;
  aliaModel: AliaModel;
  isFallback: boolean;
  fallbackIndex?: number;
}

/**
 * Resolve an Alia model ID to a concrete provider and model.
 * Uses the providers API for key-manager + circuit breaker + priority rotation.
 *
 * @param aliasModelId - The Alia model ID (e.g., "alia-v1", "alia-lite")
 * @param skipProviders - Providers to skip (for retry scenarios)
 * @param skipKeyIds - Specific key IDs to skip (for retry scenarios)
 * @returns Resolved model with key config, or null if no providers available
 */
export async function resolveModel(
  aliasModelId: string,
  skipProviders?: Set<string>,
  skipKeyIds?: Set<string>
): Promise<ResolvedModel | null> {
  const result = await internalResolveAliaModel(
    aliasModelId,
    1000,
    skipProviders || new Set(),
    skipKeyIds
  );
  if (!result) return null;
  return {
    ...result,
    aliasModelId: result.aliasModelId || aliasModelId,
  } as ResolvedModel;
}

/**
 * Create an AI SDK model instance based on the resolved key config.
 */
export function getAIModel(keyConfig: KeyConfig) {
  const apiKey = keyConfig.key;
  const modelId = keyConfig.modelId;

  switch (keyConfig.provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId || 'gemini-2.5-flash');
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai.chat(modelId || 'gpt-4o-mini');
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId || 'claude-sonnet-4-20250514');
    }
    case 'groq': {
      const groq = createOpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
      return groq.chat(modelId || 'llama-3.3-70b-versatile');
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.ai/v1',
      });
      return together.chat(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1',
      });
      return cerebras.chat(modelId || 'llama3.1-8b');
    }
    case 'mistral': {
      const mistral = createOpenAI({
        apiKey,
        baseURL: 'https://api.mistral.ai/v1',
      });
      return mistral.chat(modelId || 'mistral-large-latest');
    }
    case 'deepseek': {
      const deepseek = createOpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
      });
      return deepseek.chat(modelId || 'deepseek-chat');
    }
    case 'openrouter': {
      const openrouter = createOpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
      });
      return openrouter.chat(modelId || 'meta-llama/llama-3.3-70b-instruct');
    }
    case 'replicate': {
      const replicate = createOpenAI({
        apiKey,
        baseURL: 'https://api.replicate.com/v1',
      });
      return replicate.chat(modelId || 'meta/meta-llama-3.3-70b-instruct');
    }
    case 'cloudflare': {
      const [accountId, apiToken] = apiKey.split(':');
      const cf = createOpenAI({
        apiKey: apiToken || apiKey,
        baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      });
      return cf.chat(modelId || '@cf/meta/llama-3.2-11b-vision-instruct');
    }
    case 'cohere': {
      const cohere = createOpenAI({
        apiKey,
        baseURL: 'https://api.cohere.ai/compatibility/v1',
      });
      return cohere.chat(modelId || 'command-a-03-2025');
    }
    case 'xai': {
      const xai = createOpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1',
      });
      return xai.chat(modelId || 'grok-4-fast');
    }
    case 'fireworks': {
      const fireworks = createOpenAI({
        apiKey,
        baseURL: 'https://api.fireworks.ai/inference/v1',
      });
      return fireworks.chat(modelId || 'accounts/fireworks/models/deepseek-v3');
    }
    case 'perplexity': {
      const perplexity = createOpenAI({
        apiKey,
        baseURL: 'https://api.perplexity.ai',
      });
      return perplexity.chat(modelId || 'sonar');
    }
    case 'sambanova': {
      const sambanova = createOpenAI({
        apiKey,
        baseURL: 'https://api.sambanova.ai/v1',
      });
      return sambanova.chat(modelId || 'Meta-Llama-3.3-70B-Instruct');
    }
    case 'hyperbolic': {
      const hyperbolic = createOpenAI({
        apiKey,
        baseURL: 'https://api.hyperbolic.xyz/v1',
      });
      return hyperbolic.chat(modelId || 'deepseek-ai/DeepSeek-V3');
    }
    case 'novita': {
      const novita = createOpenAI({
        apiKey,
        baseURL: 'https://api.novita.ai/v3/openai',
      });
      return novita.chat(modelId || 'meta-llama/llama-3.3-70b-instruct');
    }
    default:
      throw new Error(`Provider "${keyConfig.provider}" not supported`);
  }
}

/**
 * Report the result of a provider call for health tracking and key rotation.
 * Delegates to the providers API via providers-client (fire-and-forget).
 *
 * @param keyId - The key ID from the resolved model (may not exist for env-based keys)
 * @param provider - Provider name
 * @param modelId - Model ID used
 * @param success - Whether the request succeeded
 * @param latencyMs - Request latency in milliseconds
 * @param errorCode - Error code if failed
 */
export async function reportModelUsage(
  keyId: string | undefined,
  provider: string,
  modelId: string,
  success: boolean,
  latencyMs: number = 0,
  errorCode?: string
): Promise<void> {
  reportToProvidersAPI(
    keyId || '',
    provider,
    modelId,
    success,
    { latencyMs, errorCode: errorCode || undefined }
  );
}
