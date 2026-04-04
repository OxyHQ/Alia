import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types';

// ============== OPENROUTER ==============
// Unified API that provides access to 100+ models from multiple providers
// Free tier: $5 credits for new users, 20 RPM, 50 RPD
export const openrouterProvider: Provider = {
  name: 'OpenRouter',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = 'https://openrouter.ai/api/v1/chat/completions';

    const body: any = {
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
        'Authorization': `Bearer ${key.key}`,
        'HTTP-Referer': 'https://clarity.oxy.so', // Optional: for rankings
        'X-Title': 'Clarity AI' // Optional: for rankings
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }

    // OpenRouter uses OpenAI-compatible format
    return res.body!;
  }
};
