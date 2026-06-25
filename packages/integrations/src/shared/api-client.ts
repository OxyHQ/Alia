import axios, { AxiosInstance } from 'axios';
import { errorCode, errorStatus } from './utils';

/** OpenAI-compatible message content — plain string or multi-part array */
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
export type MessageContent = string | MessageContentPart[];

/** A bot user record linking a platform identity to an Oxy account. */
export interface BotUser {
  oxyUserId: string;
  platformUserId: string;
  conversationId?: string;
  model?: string;
  preferredModel?: string;
  isLinked?: boolean;
  linkedAt?: string;
  displayName?: string;
  username?: string;
  [key: string]: unknown;
}

/** A single stored conversation message. */
export interface ConversationMessage {
  role: string;
  content: MessageContent;
  [key: string]: unknown;
}

/** A stored conversation with its message history. */
export interface Conversation {
  conversationId?: string;
  id?: string;
  title?: string;
  messages?: ConversationMessage[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A model entry from the gateway `/v1/models` listing. */
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  category?: string;
  pricing?: { credit_multiplier: number };
  [key: string]: unknown;
}

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

  async getBotUser(platformUserId: string): Promise<BotUser | null> {
    try {
      const response = await this.client.get(
        `/bots/internal/${this.platform}/users/${platformUserId}`,
        { headers: this.authHeaders },
      );
      return response.data;
    } catch (error: unknown) {
      if (errorStatus(error) === 404) return null;
      throw error;
    }
  }

  async createOrUpdateBotUser(data: {
    platformUserId: string;
    chatId: string;
    username?: string;
    displayName?: string;
  }): Promise<BotUser> {
    const response = await this.client.post(
      `/bots/internal/${this.platform}/users`,
      data,
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async requestAuthToken(platformUserId: string): Promise<{
    authToken: string;
    authUrl: string;
    expiresAt: Date;
  }> {
    const response = await this.client.post(
      `/bots/internal/${this.platform}/auth-request`,
      { platformUserId },
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async updateConversation(platformUserId: string, conversationId: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${platformUserId}/conversation`,
      { conversationId },
      { headers: this.authHeaders },
    );
  }

  async getConversation(oxyUserId: string, conversationId: string): Promise<Conversation | null> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}`, {
        headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
      });
      return response.data;
    } catch (error: unknown) {
      if (errorStatus(error) === 404) return null;
      throw error;
    }
  }

  async saveConversation(
    oxyUserId: string,
    conversationId: string,
    messages: ConversationMessage[],
    title?: string,
  ): Promise<Conversation> {
    const response = await this.client.post(
      '/conversations',
      { conversationId, messages, title },
      { headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId } },
    );
    return response.data;
  }

  async getConversations(oxyUserId: string): Promise<Conversation[]> {
    const response = await this.client.get('/conversations', {
      headers: { ...this.authHeaders, 'X-Oxy-User-Id': oxyUserId },
    });
    return response.data;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.get('/v1/models');
      return response.data.data || [];
    } catch {
      return [];
    }
  }

  async updateModel(platformUserId: string, model: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${platformUserId}/model`,
      { model },
      { headers: this.authHeaders },
    );
  }

  async logoutUser(platformUserId: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${platformUserId}/logout`,
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
      const err: Error & { status?: number; code?: unknown } = new Error(body.error?.message || body.error || `HTTP ${response.status}`);
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
      const err: Error & { status?: number; code?: unknown } = new Error(body.error?.message || body.error || `HTTP ${response.status}`);
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
