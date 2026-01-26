/**
 * Model Resolver for Codea
 *
 * Requests provider key and model info from Alia API, then creates AI SDK instances.
 * This keeps authentication and key management on the server while allowing
 * Codea to use AI SDK directly without format conversion.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

export interface ResolvedModel {
  model: any; // AI SDK model instance
  provider: string;
  modelId: string;
  sessionId: string; // For tracking usage
}

/**
 * Resolve model from Alia API and create AI SDK instance
 * Returns a ready-to-use AI SDK model with provider key
 */
export async function resolveModel(
  baseUrl: string,
  apiKey: string,
  aliaModelId: string
): Promise<ResolvedModel> {
  const url = `${baseUrl}/v1/resolve-model`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: aliaModelId, clientType: 'codea' })
    });

    if (!response.ok) {
      const errorData = await response.text();
      try {
        const error = JSON.parse(errorData);
        throw new Error(error.error || `HTTP ${response.status}`);
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`HTTP ${response.status}: ${errorData}`);
        }
        throw e;
      }
    }

    const parsed = await response.json() as { provider: string; modelId: string; providerKey: string; sessionId: string };
    const model = createAIModel(parsed.provider, parsed.modelId, parsed.providerKey);

    return {
      model,
      provider: parsed.provider,
      modelId: parsed.modelId,
      sessionId: parsed.sessionId
    };
  } catch (error: any) {
    throw new Error(`Failed to resolve model: ${error.message}`);
  }
}

/**
 * Report usage back to Alia API for credit tracking
 */
export async function reportUsage(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
): Promise<void> {
  const url = `${baseUrl}/v1/report-usage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ sessionId, usage })
    });
  } catch {
    // Ignore errors on usage reporting
  }
}

/**
 * Create AI SDK model instance from provider config
 */
export function createAIModel(provider: string, modelId: string, apiKey: string): any {
  switch (provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }
    case 'groq': {
      const groq = createOpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      });
      return groq(modelId);
    }
    case 'together': {
      const together = createOpenAI({
        apiKey,
        baseURL: 'https://api.together.ai/v1'
      });
      return together(modelId);
    }
    case 'cerebras': {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: 'https://api.cerebras.ai/v1'
      });
      return cerebras(modelId);
    }
    default:
      throw new Error(`Provider "${provider}" not supported`);
  }
}
