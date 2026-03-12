import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types.js';

// ============== CLOUDFLARE WORKERS AI ==============
// Serverless AI inference on Cloudflare's global network
// Free tier: 10,000 neurons per day
export const cloudflareProvider: Provider = {
  name: 'Cloudflare',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    // Cloudflare Workers AI uses account ID in the URL
    // Format: https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
    // We'll store account_id in the key string as "account_id:api_token"
    const [accountId, apiToken] = key.key.split(':');

    if (!accountId || !apiToken) {
      throw new Error('Cloudflare key must be in format: account_id:api_token');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const body: any = {
      model: key.modelId,
      messages,
      temperature: config?.temperature ?? 0.7,
      max_tokens: config?.maxTokens ?? 8192,
      stream: true
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Cloudflare ${res.status}: ${await res.text()}`);
    }

    // Cloudflare Workers AI uses OpenAI-compatible format
    return res.body!;
  }
};
