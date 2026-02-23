import axios, { AxiosInstance } from 'axios';

/** OpenAI-compatible message content — plain string or multi-part array */
type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type MessageContent = string | MessageContentPart[];

/**
 * Parameterized API client — one instance per platform, all sharing the same core logic.
 */
export class APIClient {
  private client: AxiosInstance;
  private platform: string;
  private secret: string;

  constructor(platform: string, secret: string) {
    this.platform = platform;
    this.secret = secret;
    const baseURL = process.env.API_BASE_URL || 'http://localhost:3001';
    this.client = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private get authHeaders() {
    return { 'X-Channel-Bot-Secret': this.secret };
  }

  async getChannelUser(channelUserId: string): Promise<any> {
    try {
      const response = await this.client.get(
        `/bots/internal/${this.platform}/users/${channelUserId}`,
        { headers: this.authHeaders },
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async createOrUpdateChannelUser(data: {
    platformUserId: string;
    chatId: string;
    username?: string;
    displayName?: string;
  }): Promise<any> {
    const response = await this.client.post(
      `/bots/internal/${this.platform}/users`,
      data,
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async requestAuthToken(channelUserId: string): Promise<{
    authToken: string;
    authUrl: string;
    expiresAt: Date;
  }> {
    const response = await this.client.post(
      `/bots/internal/${this.platform}/auth-request`,
      { platformUserId: channelUserId },
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async updateConversation(channelUserId: string, conversationId: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${channelUserId}/conversation`,
      { conversationId },
      { headers: this.authHeaders },
    );
  }

  async getConversation(oxyUserId: string, conversationId: string): Promise<any> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}`, {
        headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async saveConversation(
    oxyUserId: string,
    conversationId: string,
    messages: any[],
    title?: string,
  ): Promise<any> {
    const response = await this.client.post(
      '/conversations',
      { conversationId, messages, title },
      { headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId } },
    );
    return response.data;
  }

  async getConversations(oxyUserId: string): Promise<any[]> {
    const response = await this.client.get('/conversations', {
      headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
    });
    return response.data;
  }

  async fetchModels(): Promise<any[]> {
    try {
      const response = await this.client.get('/v1/models');
      return response.data.data || [];
    } catch {
      return [];
    }
  }

  async updateModel(channelUserId: string, model: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${channelUserId}/model`,
      { model },
      { headers: this.authHeaders },
    );
  }

  async logoutUser(channelUserId: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${channelUserId}/logout`,
      {},
      { headers: this.authHeaders },
    );
  }

  // ---------------------------------------------------------------------------
  // Chat completions — route AI calls through the main API
  // ---------------------------------------------------------------------------

  private get baseURL(): string {
    return process.env.API_BASE_URL || 'http://localhost:3001';
  }

  /**
   * Non-streaming chat completion (Discord, gateway adapters).
   */
  async chatCompletion(
    oxyUserId: string,
    messages: Array<{ role: string; content: MessageContent }>,
    options: { model?: string; conversationId?: string } = {},
  ): Promise<{ content: string; finishReason: string }> {
    const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Channel-Bot-Secret': this.secret,
        'X-Oxy-User-Id': oxyUserId,
      },
      body: JSON.stringify({
        messages,
        model: options.model || 'alia-lite',
        stream: false,
        conversationId: options.conversationId,
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      const err: any = new Error(body.error?.message || body.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.code = body.error?.code;
      throw err;
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      finishReason: choice?.finish_reason || 'stop',
    };
  }

  /**
   * Transcribe audio to text via the voice/transcribe API endpoint.
   */
  async transcribe(
    oxyUserId: string,
    audio: string,
    format?: string,
  ): Promise<string> {
    const response = await this.client.post(
      '/v1/voice/transcribe',
      { audio, format },
      {
        headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
        timeout: 30000,
      },
    );
    return response.data.text;
  }

  /**
   * Streaming chat completion — async generator yielding text deltas (Telegram).
   * Tools execute server-side; only text content is yielded.
   */
  async *chatCompletionStream(
    oxyUserId: string,
    messages: Array<{ role: string; content: MessageContent }>,
    options: { model?: string; conversationId?: string } = {},
  ): AsyncGenerator<string, void, undefined> {
    const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Channel-Bot-Secret': this.secret,
        'X-Oxy-User-Id': oxyUserId,
      },
      body: JSON.stringify({
        messages,
        model: options.model || 'alia-lite',
        stream: true,
        conversationId: options.conversationId,
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      const err: any = new Error(body.error?.message || body.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.code = body.error?.code;
      throw err;
    }

    if (!response.body) {
      throw new Error('No response body for streaming request');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
