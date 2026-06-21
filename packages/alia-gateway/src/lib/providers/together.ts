import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types.js';

// ============== TOGETHER AI ==============
export const togetherProvider: Provider = {
  name: 'Together AI',
  
  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = 'https://api.together.ai/v1/chat/completions';
    
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
      throw new Error(`Together ${res.status}: ${await res.text()}`);
    }

    if (!res.body) throw new Error('Together returned empty response body');
    return res.body;
  }
};
