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
import { kaanaServes } from './inference/kaana-catalogue.js';
import { kaanaLanguageModel } from './inference/kaana-language-model.js';
import type { AliaInferenceSurface } from './inference/product-seam.js';
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
  type RoutingOptions,
} from './gateway-client.js';

// Re-export types and helpers that chat routes need
export { getDefaultAliaModel, isAliaModel, getAliaModel, getAllAliaModels, getAliaModelsByCategory, getDefaultModelForCategory, getAvailableModels };
export type { KeyConfig, AliaModel, AliaModelWithAvailability, ModelCategory, RoutingOptions };

/**
 * Result of resolving an Alia model to a concrete provider/model.
 * Compatible with the shape that chat routes already expect.
 */
export interface ResolvedModel {
  aliasModelId: string;
  provider: string;
  /** Who RELEASED the model that answered. Never who serves it. */
  publisher: string;
  /** The publisher's own name for it, which is NOT {@link modelId}. */
  model: string;
  modelId: string;
  keyConfig: KeyConfig;
  /**
   * The canonical name to send Kaana, or `null` when Kaana does not serve it.
   *
   * Decided from Kaana's OWN catalogue, never from a table here: a copy of
   * someone else's catalogue keeps offering what was removed and never offers
   * what was added. `null` covers every way of not knowing — an unreachable
   * Kaana, a stale snapshot, a model line it has no deployment for — and the
   * caller then does what it did before.
   */
  kaanaReference: string | null;
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
 * @param options - Per-request routing options; omitted means today's behaviour
 * @returns Resolved model with key config, or null if no providers available
 * @throws UnregisteredModelError when `aliasModelId` names no registered model
 * @throws FallbackNotPermittedError when a non-default policy exhausts its candidates
 */
export async function resolveModel(
  aliasModelId: string,
  skipProviders?: Set<string>,
  skipKeyIds?: Set<string>,
  options?: RoutingOptions
): Promise<ResolvedModel | null> {
  const result = await internalResolveAliaModel(
    aliasModelId,
    1000,
    skipProviders || new Set(),
    skipKeyIds,
    options
  );
  if (!result) return null;
  // `publisher/model` — who released it over what they call it — is the shape
  // Kaana names every deployment by, and Alia already carries both halves. The
  // provider-native `modelId` is NOT that name: `claude-sonnet-4-20250514` and
  // `deepseek-chat` are what one vendor's API calls them, and Kaana answers
  // `invalid_request` to both.
  const canonical =
    result.publisher === undefined || result.model === undefined
      ? null
      : `${result.publisher}/${result.model}`;
  return {
    ...result,
    aliasModelId: result.aliasModelId || aliasModelId,
    kaanaReference: canonical !== null && (await kaanaServes(canonical)) ? canonical : null,
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
export function getAIModel(resolved: ResolvedModel, surface: AliaInferenceSurface) {
  // Kaana first, and not as a fallback: whether it serves this model was
  // decided from its own catalogue before the call, so there is no error to
  // recover from here. A try-Kaana-then-retry-elsewhere shape would bill twice
  // for one answer and hide which one produced it.
  //
  // A non-empty STRING, not merely `!== null`: a resolution that never set the
  // field at all — a fixture, or a remote gateway that returns its own shape —
  // would otherwise be routed to Kaana under the reference `undefined`. The
  // type says the field is there; the value is what decides.
  const reference = resolved.kaanaReference;
  if (typeof reference === 'string' && reference !== '') {
    return kaanaLanguageModel({ modelReference: reference, surface });
  }

  const keyConfig = resolved.keyConfig;
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
      // Not `llama-3.3-70b-versatile`: Groq decommissioned the llama-3.3 line
      // and a request for it returns 404 `model_not_found` (measured
      // 2026-08-23), so this last-resort default was a hole in the safety net
      // rather than a safety net. `openai/gpt-oss-20b` answered 200 on the same
      // probe. NOTE that a provider's `/v1/models` is not authoritative for
      // this question on every provider — xAI serves `grok-4-fast` while
      // omitting it from the list — so verify a default by CALLING it.
      return groq.chat(modelId || 'openai/gpt-oss-20b');
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
    case 'cheaperinference': {
      const cheaperinference = openAICompatibleProvider(provider, apiKey, 'https://api.cheaperinference.com/v1');
      // No `||` default: this operator fronts other vendors' catalogues, so
      // there is no model it is guaranteed to serve. A caller that reaches here
      // without a modelId has a missing mapping, and an invented id would turn
      // that into an upstream 404 instead.
      return cheaperinference.chat(modelId);
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
