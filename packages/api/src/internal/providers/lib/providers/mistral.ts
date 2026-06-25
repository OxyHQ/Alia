import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types';

// ============== MISTRAL AI ==============
// French AI company with excellent coding models
// Free tier available for testing and development
export const mistralProvider: Provider = {
  name: 'Mistral',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = 'https://api.mistral.ai/v1/chat/completions';

    const body: Record<string, unknown> = {
      model: key.modelId,
      messages,
      temperature: config?.temperature ?? 0.7,
      max_tokens: config?.maxTokens ?? 8192,
      stream: true
    };

    if (tools?.length) body.tools = tools;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key.key}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Mistral ${res.status}: ${await res.text()}`);
    }

    // Mistral uses OpenAI-compatible format
    return res.body!;
  }
};
