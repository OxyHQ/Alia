import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types';

// ============== DIGITALOCEAN GRADIENT ==============
// Fully-managed AI inference platform with OpenAI-compatible API
// Provides access to OpenAI, Anthropic, Meta, DeepSeek, Mistral, and Alibaba models
export const digitaloceanProvider: Provider = {
  name: 'DigitalOcean',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = 'https://inference.do-ai.run/v1/chat/completions';

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
        'Authorization': `Bearer ${key.key}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`DigitalOcean ${res.status}: ${await res.text()}`);
    }

    // DigitalOcean Gradient uses OpenAI-compatible format
    return res.body!;
  }
};
