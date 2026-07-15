/**
 * Chat Core - Shared logic for all chat endpoints
 *
 * Provides model resolution via internal providers module,
 * AI SDK model creation, and health reporting.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

import { TTLCache } from './ttl-cache.js';
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
} from './gateway-client.js';

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
 * Uses the gateway API for key-manager + circuit breaker + priority rotation.
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
 * Provider-instance cache. `createOpenAI`/`createAnthropic`/`createGoogleGenerativeAI`
 * return stateless factories bound to an apiKey (+ baseURL); reusing them across
 * requests is exactly what the AI SDK recommends. We memoize the factory and
 * build the per-request model object on top of it. Keyed by provider + baseURL
 * + apiKey so a key rotation produces a fresh instance.
 */
type ProviderInstance =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>;

const providerCache = new TTLCache<ProviderInstance>({ ttlMs: 10 * 60 * 1000, maxSize: 200 });

function getProvider<T extends ProviderInstance>(
  provider: string,
  baseURL: string | undefined,
  apiKey: string,
  factory: () => T,
): T {
  const key = `${provider}|${baseURL ?? ''}|${apiKey}`;
  const cached = providerCache.get(key);
  if (cached) return cached as T;
  const created = factory();
  providerCache.set(key, created);
  return created;
}

/** Memoized OpenAI-compatible provider (Groq, Together, xAI, DeepSeek, …). */
function openAICompatibleProvider(provider: string, apiKey: string, baseURL: string) {
  return getProvider(provider, baseURL, apiKey, () => createOpenAI({ apiKey, baseURL }));
}

/**
 * Create an AI SDK model instance based on the resolved key config.
 */
export function getAIModel(keyConfig: KeyConfig) {
  const apiKey = keyConfig.key;
  const modelId = keyConfig.modelId;
  const provider = keyConfig.provider;

  switch (provider) {
    case 'google': {
      const google = getProvider(provider, undefined, apiKey, () => createGoogleGenerativeAI({ apiKey }));
      return google(modelId || 'gemini-2.5-flash');
    }
    case 'openai': {
      const openai = getProvider(provider, undefined, apiKey, () => createOpenAI({ apiKey }));
      return openai.chat(modelId || 'gpt-4o-mini');
    }
    case 'anthropic': {
      const anthropic = getProvider(provider, undefined, apiKey, () => createAnthropic({ apiKey }));
      return anthropic(modelId || 'claude-sonnet-4-20250514');
    }
    case 'groq': {
      const groq = openAICompatibleProvider(provider, apiKey, 'https://api.groq.com/openai/v1');
      return groq.chat(modelId || 'llama-3.3-70b-versatile');
    }
    case 'together': {
      const together = openAICompatibleProvider(provider, apiKey, 'https://api.together.ai/v1');
      return together.chat(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    }
    case 'cerebras': {
      const cerebras = openAICompatibleProvider(provider, apiKey, 'https://api.cerebras.ai/v1');
      return cerebras.chat(modelId || 'llama3.1-8b');
    }
    case 'mistral': {
      const mistral = openAICompatibleProvider(provider, apiKey, 'https://api.mistral.ai/v1');
      return mistral.chat(modelId || 'mistral-large-latest');
    }
    case 'deepseek': {
      const deepseek = openAICompatibleProvider(provider, apiKey, 'https://api.deepseek.com');
      return deepseek.chat(modelId || 'deepseek-chat');
    }
    case 'openrouter': {
      const openrouter = openAICompatibleProvider(provider, apiKey, 'https://openrouter.ai/api/v1');
      return openrouter.chat(modelId || 'meta-llama/llama-3.3-70b-instruct');
    }
    case 'replicate': {
      const replicate = openAICompatibleProvider(provider, apiKey, 'https://api.replicate.com/v1');
      return replicate.chat(modelId || 'meta/meta-llama-3.3-70b-instruct');
    }
    case 'cloudflare': {
      const [accountId, apiToken] = apiKey.split(':');
      const cfKey = apiToken || apiKey;
      const cfBaseURL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
      const cf = getProvider(provider, cfBaseURL, cfKey, () => createOpenAI({ apiKey: cfKey, baseURL: cfBaseURL }));
      return cf.chat(modelId || '@cf/meta/llama-3.2-11b-vision-instruct');
    }
    case 'cohere': {
      const cohere = openAICompatibleProvider(provider, apiKey, 'https://api.cohere.ai/compatibility/v1');
      return cohere.chat(modelId || 'command-a-03-2025');
    }
    case 'xai': {
      const xai = openAICompatibleProvider(provider, apiKey, 'https://api.x.ai/v1');
      return xai.chat(modelId || 'grok-4-fast');
    }
    case 'fireworks': {
      const fireworks = openAICompatibleProvider(provider, apiKey, 'https://api.fireworks.ai/inference/v1');
      return fireworks.chat(modelId || 'accounts/fireworks/models/deepseek-v3');
    }
    case 'perplexity': {
      const perplexity = openAICompatibleProvider(provider, apiKey, 'https://api.perplexity.ai');
      return perplexity.chat(modelId || 'sonar');
    }
    case 'sambanova': {
      const sambanova = openAICompatibleProvider(provider, apiKey, 'https://api.sambanova.ai/v1');
      return sambanova.chat(modelId || 'Meta-Llama-3.3-70B-Instruct');
    }
    case 'hyperbolic': {
      const hyperbolic = openAICompatibleProvider(provider, apiKey, 'https://api.hyperbolic.xyz/v1');
      return hyperbolic.chat(modelId || 'deepseek-ai/DeepSeek-V3');
    }
    case 'novita': {
      const novita = openAICompatibleProvider(provider, apiKey, 'https://api.novita.ai/v3/openai');
      return novita.chat(modelId || 'meta-llama/llama-3.3-70b-instruct');
    }
    case 'digitalocean': {
      const digitalocean = openAICompatibleProvider(provider, apiKey, 'https://inference.do-ai.run/v1');
      return digitalocean.chat(modelId || 'openai-gpt-5-nano');
    }
    default:
      throw new Error(`Provider "${provider}" not supported`);
  }
}

/**
 * Report the result of a provider call for health tracking and key rotation.
 * Delegates to the gateway API via gateway-client (fire-and-forget).
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
  errorCode?: string,
  retryAfterMs?: number
): Promise<void> {
  reportToProvidersAPI(
    keyId || '',
    provider,
    modelId,
    success,
    { latencyMs, errorCode: errorCode || undefined, retryAfterMs }
  );
}
