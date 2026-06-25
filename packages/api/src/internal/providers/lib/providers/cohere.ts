import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types';

// ============== COHERE ==============
// Cohere provides an OpenAI-compatible endpoint at /compatibility/v1.
export const cohereProvider: Provider = {
  name: 'Cohere',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = 'https://api.cohere.ai/compatibility/v1/chat/completions';

    const body: Record<string, unknown> = {
      model: key.modelId,
      messages,
      temperature: config?.temperature ?? 0.7,
      max_tokens: config?.maxTokens ?? 8192,
      stream: true,
    };

    if (tools?.length) body.tools = tools;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key.key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Cohere ${res.status}: ${await res.text()}`);
    }

    return res.body!;
  },
};
