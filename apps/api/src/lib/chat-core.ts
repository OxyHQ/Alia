/**
 * Chat Core - Shared logic for all chat endpoints
 *
 * Provides model resolution via internal providers module,
 * AI SDK model creation, and health reporting.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

import { resolveAliaModel as internalResolveAliaModel, getDefaultAliaModel } from '../internal/providers/lib/model-resolver';
import { recordKeySuccess, recordKeyFailure } from '../internal/providers/lib/key-manager';
import { recordSuccess, recordFailure } from '../internal/providers/lib/provider-health';
import { isAliaModel, getAliaModel, getAllAliaModels, getAliaModelsByCategory, getDefaultModelForCategory } from '../internal/providers/lib/alia-models';
import type { KeyConfig } from '../internal/providers/lib/types';
import type { AliaModel, ModelCategory } from '../internal/providers/lib/alia-models';

// Re-export types and helpers that chat routes need
export { getDefaultAliaModel, isAliaModel, getAliaModel, getAllAliaModels, getAliaModelsByCategory, getDefaultModelForCategory };
export type { KeyConfig, AliaModel, ModelCategory };

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
  fallbackIndex: number;
}

/**
 * Resolve an Alia model ID to a concrete provider and model.
 * Uses the internal providers module (key-manager + circuit breaker + priority rotation).
 *
 * @param aliasModelId - The Alia model ID (e.g., "alia-v1", "alia-lite")
 * @param skipProviders - Providers to skip (for retry scenarios)
 * @returns Resolved model with key config, or null if no providers available
 */
export async function resolveModel(
  aliasModelId: string,
  skipProviders?: Set<string>
): Promise<ResolvedModel | null> {
  return internalResolveAliaModel(
    aliasModelId,
    1000,
    skipProviders || new Set()
  );
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
      return openai(modelId || 'gpt-4o-mini');
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
      return groq(modelId || 'llama-3.3-70b-versatile');
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.ai/v1',
      });
      return together(modelId || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1',
      });
      return cerebras(modelId || 'llama-3.3-70b');
    }
    case 'mistral': {
      const mistral = createOpenAI({
        apiKey,
        baseURL: 'https://api.mistral.ai/v1',
      });
      return mistral(modelId || 'mistral-large-latest');
    }
    case 'deepseek': {
      const deepseek = createOpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
      });
      return deepseek(modelId || 'deepseek-chat');
    }
    case 'openrouter': {
      const openrouter = createOpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
      });
      return openrouter(modelId || 'meta-llama/llama-3.3-70b-instruct');
    }
    default:
      throw new Error(`Provider "${keyConfig.provider}" not supported`);
  }
}

/**
 * Report the result of a provider call for health tracking and key rotation.
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
  try {
    // Report to provider health (circuit breaker)
    if (success) {
      await recordSuccess(provider, modelId, latencyMs);
    } else {
      await recordFailure(provider, modelId, errorCode);
    }

    // Report to key manager (priority rotation)
    if (keyId) {
      if (success) {
        await recordKeySuccess(keyId);
      } else {
        await recordKeyFailure(keyId, errorCode || 'unknown error');
      }
    }
  } catch (err: any) {
    // Health reporting should never break the request flow
    console.error('[ChatCore] Error reporting model usage:', err.message);
  }
}
