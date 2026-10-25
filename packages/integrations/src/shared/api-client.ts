import {
  ALIA_CHANNEL_HEADER,
  ALIA_PLATFORM_USER_HEADER,
  ALIA_CHANNEL_SESSION_HEADER,
  type AliaChannelIdentity,
} from '@alia.onl/server/internal';
import { aliaApiFetch } from './oxy';
import { errorCode, errorStatus } from './utils';
import { parseCatalogue, resolveRequestModel, type Catalogue } from './catalogue';

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

/** How long a catalogue is reused before it is asked for again. */
const CATALOGUE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Parameterized API client — one instance per platform, all sharing the same core logic.
 */
export class APIClient {
  private client = {
    get: (path: string, options?: { headers?: HeadersInit; timeout?: number }) =>
      this.jsonRequest('GET', path, undefined, options),
    post: (path: string, body: unknown, options?: { headers?: HeadersInit; timeout?: number }) =>
      this.jsonRequest('POST', path, body, options),
  };
  private platform: string;
  private cachedCatalogue: Catalogue | null = null;
  private cachedCatalogueAt = 0;

  constructor(platform: string) {
    this.platform = platform;
  }

  private get authHeaders(): Record<string, string> {
    return { [ALIA_CHANNEL_HEADER]: this.platform };
  }

  private accountHeaders(identity: AliaChannelIdentity): Record<string, string> {
    return {
      ...this.authHeaders,
      ...(identity.kind === 'bot'
        ? { [ALIA_PLATFORM_USER_HEADER]: identity.platformUserId }
        : { [ALIA_CHANNEL_SESSION_HEADER]: identity.sessionId }),
    };
  }

  private async jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: HeadersInit; timeout?: number } = {},
  ): Promise<{ data: any }> {
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await aliaApiFetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
    });
    if (!response.ok) {
      const error = Object.assign(new Error(`Alia request failed (${response.status})`), {
        status: response.status,
      });
      throw error;
    }
    return { data: await response.json() };
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
    const response = await this.client.post(`/bots/internal/${this.platform}/users`, data, {
      headers: this.authHeaders,
    });
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

  async getConversation(
    identity: AliaChannelIdentity,
    conversationId: string,
  ): Promise<Conversation | null> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}`, {
        headers: this.accountHeaders(identity),
      });
      return response.data;
    } catch (error: unknown) {
      if (errorStatus(error) === 404) return null;
      throw error;
    }
  }

  async saveConversation(
    identity: AliaChannelIdentity,
    conversationId: string,
    messages: ConversationMessage[],
    title?: string,
  ): Promise<Conversation> {
    const response = await this.client.post(
      '/conversations',
      { conversationId, messages, title },
      { headers: this.accountHeaders(identity) },
    );
    return response.data;
  }

  async getConversations(identity: AliaChannelIdentity): Promise<Conversation[]> {
    const response = await this.client.get('/conversations', {
      headers: this.accountHeaders(identity),
    });
    return response.data;
  }

  /**
   * The model catalogue (`GET /catalogue`), or `null` when it could not be read.
   *
   * No provider-link context is attached: the catalogue is public, so one would
   * buy nothing and widen where it travels. `null` rather than an empty
   * catalogue, because "no models" and "we could not ask" are different
   * answers. A failure is NOT cached, and the previous success is not kept
   * across it: a stale listing can still offer a withdrawn model.
   *
   * Cached per client, so `/status`, `/model` and every chat turn share one
   * request per window.
   */
  async fetchCatalogue(): Promise<Catalogue | null> {
    if (
      this.cachedCatalogue !== null &&
      Date.now() - this.cachedCatalogueAt < CATALOGUE_CACHE_TTL_MS
    ) {
      return this.cachedCatalogue;
    }
    try {
      const response = await this.client.get('/catalogue');
      this.cachedCatalogue = parseCatalogue(response.data);
      this.cachedCatalogueAt = Date.now();
      return this.cachedCatalogue;
    } catch {
      this.cachedCatalogue = null;
      return null;
    }
  }

  /**
   * The `model` a chat request should carry for a stored choice, or
   * `undefined` to omit it and let the server use its default. See
   * `resolveRequestModel` in `./catalogue.ts`.
   */
  async requestModel(chosen: string | null | undefined): Promise<string | undefined> {
    return resolveRequestModel(chosen, await this.fetchCatalogue());
  }

  /** Store a person's model, or clear it (`null`) back to the server default. */
  async updateModel(platformUserId: string, model: string | null): Promise<void> {
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

  /** Shared product chat transport; channel identity is resolved live by Alia. */
  async chatCompletion(
    identity: AliaChannelIdentity,
    messages: Array<{ role: string; content: MessageContent }>,
    options: { model?: string; conversationId?: string } = {},
  ): Promise<{ content: string; finishReason: string }> {
    const response = await aliaApiFetch(`/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.accountHeaders(identity),
      },
      body: JSON.stringify({
        // Omitted when unset, exactly like `conversationId` beneath it:
        // `JSON.stringify` drops an `undefined` value, and a request that names
        // no model uses the server's own default. Callers resolve it through
        // `requestModel`. Naming an id here would bake a second, silent default
        // into this service, one no catalogue change could ever reach.
        messages,
        model: options.model,
        stream: false,
        conversationId: options.conversationId,
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      const err: Error & { status?: number; code?: unknown } = new Error(
        `Alia request failed (${response.status})`,
      );
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
  async transcribe(identity: AliaChannelIdentity, audio: string, format?: string): Promise<string> {
    const response = await this.client.post(
      '/v1/voice/transcribe',
      { audio, format },
      {
        headers: this.accountHeaders(identity),
        timeout: 30000,
      },
    );
    return response.data.text;
  }

  /**
   * Streaming chat completion — async generator yielding text deltas (Telegram).
   * Tools execute server-side; only text content is yielded.
   *
   * `/alia/chat` for the reason given on `chatCompletion` above. The SSE frames
   * parsed below are the same frames, from the same handler; `/alia/chat` is
   * additionally the mount that gets `setNoDelay(true)` and `setTimeout(0)`
   * (`packages/api/src/index.ts`), which is what a long stream wants.
   */
  async *chatCompletionStream(
    identity: AliaChannelIdentity,
    messages: Array<{ role: string; content: MessageContent }>,
    options: { model?: string; conversationId?: string } = {},
  ): AsyncGenerator<string, void, undefined> {
    const response = await aliaApiFetch(`/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.accountHeaders(identity),
      },
      body: JSON.stringify({
        // Omitted when unset — see `chatCompletion` above.
        messages,
        model: options.model,
        stream: true,
        conversationId: options.conversationId,
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      const err: Error & { status?: number; code?: unknown } = new Error(
        `Alia request failed (${response.status})`,
      );
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
