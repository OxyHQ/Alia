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
  aliaModelId: string
): Promise<ResolvedModel> {
  const url = `${baseUrl}/v1/resolve-model`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel-bot-secret': botSecret,
      'x-oxy-user-id': oxyUserId,
    },
    body: JSON.stringify({ model: aliaModelId, clientType: 'discord' })
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorData}`);
  }

  const parsed = await response.json() as any;
  const model = createAIModel(parsed.provider, parsed.modelId, parsed.providerKey);
  return { model, provider: parsed.provider, modelId: parsed.modelId, sessionId: parsed.sessionId };
}

export async function reportUsage(
  baseUrl: string,
  botSecret: string,
  oxyUserId: string,
  sessionId: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
): Promise<void> {
  try {
    await fetch(`${baseUrl}/v1/report-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-channel-bot-secret': botSecret,
        'x-oxy-user-id': oxyUserId,
      },
      body: JSON.stringify({ sessionId, usage })
    });
  } catch { /* ignore */ }
}

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
      return createOpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })(modelId);
    }
    case 'together': {
      return createOpenAI({ apiKey, baseURL: 'https://api.together.ai/v1' })(modelId);
    }
    case 'cerebras': {
      return createOpenAI({ apiKey, baseURL: 'https://api.cerebras.ai/v1' })(modelId);
    }
    default:
      throw new Error(`Provider "${provider}" not supported`);
  }
}
