/**
 * Model Resolver — shared across all messaging adapters.
 * Requests provider key + model info from Alia API, creates AI SDK instances.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

export interface ResolvedModel {
  model: any;
  provider: string;
  modelId: string;
  sessionId: string;
}

export async function resolveModel(
  baseUrl: string,
  botSecret: string,
  oxyUserId: string,
  aliaModelId: string,
  clientType: string,
): Promise<ResolvedModel> {
  const response = await fetch(`${baseUrl}/v1/resolve-model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel-bot-secret': botSecret,
      'x-oxy-user-id': oxyUserId,
    },
    body: JSON.stringify({ model: aliaModelId, clientType }),
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

  const parsed = (await response.json()) as {
    provider: string;
    modelId: string;
    providerKey: string;
    sessionId: string;
  };

  return {
    model: createAIModel(parsed.provider, parsed.modelId, parsed.providerKey),
    provider: parsed.provider,
    modelId: parsed.modelId,
    sessionId: parsed.sessionId,
  };
}

export async function reportUsage(
  baseUrl: string,
  botSecret: string,
  oxyUserId: string,
  sessionId: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): Promise<void> {
  try {
    await fetch(`${baseUrl}/v1/report-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-channel-bot-secret': botSecret,
        'x-oxy-user-id': oxyUserId,
      },
      body: JSON.stringify({ sessionId, usage }),
    });
  } catch {
    // Usage reporting is best-effort
  }
}

export function createAIModel(provider: string, modelId: string, apiKey: string): any {
  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'groq':
      return createOpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })(modelId);
    case 'together':
      return createOpenAI({ apiKey, baseURL: 'https://api.together.ai/v1' })(modelId);
    case 'cerebras':
      return createOpenAI({ apiKey, baseURL: 'https://api.cerebras.ai/v1' })(modelId);
    default:
      throw new Error(`Provider "${provider}" not supported`);
  }
}
