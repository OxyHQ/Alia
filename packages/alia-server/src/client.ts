import { AliaRequestError, AliaStreamError, isRecord } from './errors.js';
import type { AliaStreamEvent } from './events.js';
import { readAliaEventStream } from './stream.js';

/** Alia's public product API. */
export const ALIA_API_URL = 'https://api.alia.onl';

/** Alia's permanent, OpenAI-compatible chat path (ADR 0010). */
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/** How much of a non-2xx body is read to look for a machine-readable code. */
const MAX_ERROR_BODY_BYTES = 4096;

export type AliaHeaders = Readonly<Record<string, string>>;

export interface AliaChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}

/**
 * One turn. `stream` is not an option: this client only streams, which is why
 * it can promise that every byte lands in a typed event.
 */
export interface AliaChatCompletionRequest {
  readonly messages: readonly AliaChatMessage[];
  /** The Alia agent this turn runs as. */
  readonly agentId?: string;
  /** A routing-profile id. Omit it and Alia picks the product default. */
  readonly model?: string;
  readonly conversationId?: string;
  readonly reasoningEffort?: string;
  readonly webSearch?: boolean;
  readonly deepResearch?: boolean;
  readonly clientContext?: string;
  /**
   * Anything else the product route accepts. Merged UNDER the fields above, so
   * a typed field always wins and `stream` can never be turned off.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface AliaServerClientOptions {
  /** e.g. `https://api.alia.onl`. A trailing slash is ignored. */
  readonly baseUrl?: string;
  /**
   * The calling product's Oxy service token — the bearer Oxy bills. A function
   * is called once per turn, for a credential that rotates.
   */
  readonly token?: string | (() => string | Promise<string>);
  /**
   * Extra headers. A function is called once per turn, which is what a one-use
   * header such as `X-Oxy-Requester-Assertion` needs: Oxy consumes each
   * assertion, so it must be minted per request and never cached.
   */
  readonly headers?: AliaHeaders | (() => AliaHeaders | Promise<AliaHeaders>);
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Override the chat path. Defaults to `/v1/chat/completions`. */
  readonly path?: string;
}

export interface AliaStreamInit {
  readonly signal?: AbortSignal;
  /** This turn's bearer, overriding the client's. */
  readonly token?: string;
  /** This turn's extra headers, merged over the client's. */
  readonly headers?: AliaHeaders;
}

async function resolve<T>(source: T | (() => T | Promise<T>) | undefined): Promise<T | undefined> {
  return typeof source === 'function' ? await (source as () => T | Promise<T>)() : source;
}

/** The machine-readable code from an error body, and nothing else from it. */
async function codeFromErrorBody(response: Response): Promise<string | null> {
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return null;
    const decoder = new TextDecoder('utf-8');
    let text = '';
    try {
      while (text.length < MAX_ERROR_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    if (typeof value.code === 'string') return value.code;
    if (isRecord(value.error) && typeof value.error.code === 'string') return value.error.code;
    return null;
  } catch {
    return null;
  }
}

/**
 * A backend's client for Alia's product API.
 *
 * It exists because every consumer that called Alia from a server wrote the same
 * SSE parser, and each one got a different subset of the wire right. Alia writes
 * OpenAI-shaped chunks, named product events, synthetic recovery chunks carrying
 * `alia_meta`, in-stream error payloads and a terminal `[DONE]` — five shapes,
 * of which a hand-rolled reader typically handles two and silently drops the
 * one that matters when something is wrong.
 *
 * Node 22+. No React, no DOM beyond `fetch` and `ReadableStream`.
 */
export class AliaServerClient {
  readonly #baseUrl: string;
  readonly #path: string;
  readonly #token: AliaServerClientOptions['token'];
  readonly #headers: AliaServerClientOptions['headers'];
  readonly #fetch: typeof fetch;

  constructor(options: AliaServerClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? ALIA_API_URL).replace(/\/+$/, '');
    this.#path = options.path ?? CHAT_COMPLETIONS_PATH;
    this.#token = options.token;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The absolute URL this client posts to. */
  get url(): string {
    return `${this.#baseUrl}${this.#path}`;
  }

  /**
   * Start one turn.
   *
   * Resolves once Alia has answered with a 2xx `text/event-stream`; the events
   * arrive as they are written. Throws {@link AliaRequestError} for a non-2xx
   * answer and {@link AliaStreamError} when the response is not a stream this
   * client can read.
   */
  async stream(
    request: AliaChatCompletionRequest,
    init: AliaStreamInit = {},
  ): Promise<AsyncIterable<AliaStreamEvent>> {
    const [token, headers] = await Promise.all([
      init.token === undefined ? resolve(this.#token) : init.token,
      resolve(this.#headers),
    ]);

    const response = await this.#fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
        ...init.headers,
      },
      body: JSON.stringify(buildBody(request)),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });

    if (!response.ok) {
      throw new AliaRequestError(response.status, await codeFromErrorBody(response));
    }

    const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mime !== 'text/event-stream') {
      await response.body?.cancel().catch(() => undefined);
      throw new AliaStreamError('not_event_stream', { valueType: mime ?? 'none' });
    }
    if (!response.body) throw new AliaStreamError('no_body');

    return readAliaEventStream(response.body, {
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  }
}

/** The wire body: declared fields only, undefined dropped, `stream` pinned on. */
function buildBody(request: AliaChatCompletionRequest): Record<string, unknown> {
  const { messages, extra, ...rest } = request;
  const body: Record<string, unknown> = { ...extra };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) body[key] = value;
  }
  body.messages = messages;
  body.stream = true;
  return body;
}

/** Convenience factory, for callers that would rather not write `new`. */
export function createAliaServerClient(options: AliaServerClientOptions = {}): AliaServerClient {
  return new AliaServerClient(options);
}
