/**
 * Desktop presentation and local tool assembly over the published Alia SSE reader.
 * Shared Oxy linked fetch owns request authentication and account fencing. The
 * server SDK owns framing, decoding, typed events, cancellation and byte limits.
 * OpenAI types preserve the product's multimodal and tool-message request bodies.
 */
import { AliaStreamError, readAliaEventStream, type AliaToolCallDelta } from '@alia.onl/server';
import type OpenAI from 'openai';

// ── Events ──────────────────────────────────────────────────────────────────

/** Tool fragments are the shared server contract; assembly stays local. */
export type ToolCallDelta = AliaToolCallDelta;

/** A tool call assembled from its deltas; the shape the history stores. */
export interface StreamedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type AliaStreamEvent =
  /** Answer text the user reads. */
  | { readonly type: 'content'; readonly text: string }
  /** Chain-of-thought from `alia.reasoning`; shown, never stored as the answer. */
  | { readonly type: 'reasoning'; readonly text: string }
  /** Tool-call fragments; accumulate with {@link mergeToolCallDeltas}. */
  | { readonly type: 'tool_calls'; readonly deltas: readonly ToolCallDelta[] }
  /**
   * `alia.tool_result`. For a tool THIS client defined the output is the
   * server's echo of the arguments (`lib/tool-converter.ts`) — Alia does not
   * run it, this extension does — so a consumer dispatches on the generic
   * `tool_calls` frame and reads this only for tools the server ran itself.
   */
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly name: string;
      readonly output: unknown;
    }
  /**
   * The stand-in text the server sends instead of an answer. Never rendered as
   * one, never stored as one; `retryable` says whether resending would help.
   */
  | { readonly type: 'synthetic'; readonly text: string; readonly retryable: boolean }
  | { readonly type: 'finish'; readonly reason: string }
  /** Any other named product event, for a consumer that wants it. */
  | { readonly type: 'event'; readonly name: string; readonly data: Record<string, unknown> };

/**
 * A refusal from Alia's API, before or during the stream.
 *
 * `status` is the HTTP status for a refusal that came as a response, and `null`
 * for one that arrived as an error frame after the headers were already out.
 * `code` is the server's own `error.code` (`MODEL_NOT_IN_PLAN`,
 * `unknown_routing_profile`, `authentication_required`, …) when it sent one.
 */
export class AliaChatError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  /** Alia's run reference (`Ref …`), the key support traces a failed turn by. */
  readonly reference: string | null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      code?: string | null;
      retryable?: boolean;
      reference?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'AliaChatError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryable = options.retryable ?? false;
    this.reference = options.reference ?? null;
  }
}

/** The codes that mean the account is out of credits. `QUOTA_EXCEEDED` is NOT one: that is the service's quota. */
const CREDIT_CODES: ReadonlySet<string> = new Set(['INSUFFICIENT_CREDITS', 'CREDITS_INSUFFICIENT']);

/** Whether a refusal is the account being out of credits, by its code and not by its status alone. */
export function isCreditsRefusal(error: AliaChatError): boolean {
  if (error.code !== null) return CREDIT_CODES.has(error.code);
  return error.status === 402;
}

/**
 * `CODE · Ref chatcmpl-…`: the two language-free halves support needs to trace a
 * failed turn. Empty when the server sent neither.
 */
export function failureDetail(error: AliaChatError): string {
  return [error.code, error.reference === null ? null : `Ref ${error.reference}`]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

/** A refusal's message with its code and reference appended, for a line a person can quote. */
export function withFailureDetail(message: string, error: AliaChatError): string {
  const detail = failureDetail(error);
  return detail === '' ? message : `${message} (${detail})`;
}

// ── Request ─────────────────────────────────────────────────────────────────

export interface AliaChatRequestBody {
  /** One explicit-control generation; fresh for every HTTP tool continuation. */
  readonly turnId?: string;
  /** `publisher/model`; omitted to let the server use its default. */
  readonly model?: string;
  readonly messages: readonly OpenAI.Chat.ChatCompletionMessageParam[];
  readonly tools?: readonly OpenAI.Chat.ChatCompletionTool[];
  readonly tool_choice?: 'auto' | 'none';
  readonly temperature?: number;
  readonly max_tokens?: number;
}

export interface AliaChatStreamOptions {
  readonly baseUrl: string;
  readonly body: AliaChatRequestBody;
  readonly signal?: AbortSignal;
  /** Account-fenced shared transport; it owns refresh and authorization. */
  readonly fetch: typeof fetch;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * The server's error envelope, in either of its two spellings.
 *
 * The chat handler writes `{ error: { message, type, param, code } }`; the auth
 * middleware writes `{ error: 'Authentication required' }`. Both are read, and
 * a body that is neither still yields a message naming the status.
 */
function errorFrom(payload: unknown, status: number | null): AliaChatError {
  const body = asObject(payload);
  const error = body?.error;
  const fallback = status === null ? 'Alia returned an error.' : `Alia API error (HTTP ${status}).`;
  if (typeof error === 'string') {
    return new AliaChatError(error, { status, retryable: isRetryableStatus(status) });
  }
  const detail = asObject(error);
  const message = typeof detail?.message === 'string' ? detail.message : fallback;
  const code = typeof detail?.code === 'string' ? detail.code : null;
  const retryable = detail?.retryable === true || isRetryableStatus(status);
  const reference = typeof detail?.reference === 'string' ? detail.reference : null;
  return new AliaChatError(message, { status, code, retryable, reference });
}

function isRetryableStatus(status: number | null): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Fold `delta.tool_calls` fragments into whole calls, by index.
 *
 * The first fragment for an index carries the id and the name; later ones
 * carry argument text to append. Three consumers used to write this loop
 * inline, twice each.
 */
export function mergeToolCallDeltas(
  into: StreamedToolCall[],
  deltas: readonly ToolCallDelta[],
): void {
  for (const delta of deltas) {
    const index = delta.index ?? into.length;
    const existing = into[index];
    if (existing === undefined) {
      into[index] = {
        id: delta.id ?? '',
        type: 'function',
        function: { name: delta.function?.name ?? '', arguments: delta.function?.arguments ?? '' },
      };
      continue;
    }
    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.function.name = delta.function.name;
    if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;
  }
}

/** The calls that arrived whole: an id and a name. A sparse index is skipped. */
export function completedToolCalls(
  calls: readonly (StreamedToolCall | undefined)[],
): StreamedToolCall[] {
  return calls.filter(
    (call): call is StreamedToolCall =>
      call !== undefined && call.id !== '' && call.function.name !== '',
  );
}

/**
 * One product request, with shared SSE parsing and product error/presentation mapping.
 * Only [DONE] completes a stream. Malformed or truncated responses stay failures.
 */
export async function* streamAliaChat(
  options: AliaChatStreamOptions,
): AsyncGenerator<AliaStreamEvent, void, undefined> {
  const doFetch = options.fetch;
  const response = await doFetch(`${options.baseUrl}/alia/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...options.body, stream: true }),
    signal: options.signal,
  });

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // A non-JSON refusal (a proxy page, an empty body) still names its status.
    }
    throw errorFrom(payload, response.status);
  }
  if (response.body === null) {
    throw new AliaChatError('Alia returned no response body.', { status: response.status });
  }

  try {
    for await (const event of readAliaEventStream(response.body, { signal: options.signal })) {
      switch (event.type) {
        case 'text':
          if (event.meta?.synthetic === true) {
            yield { type: 'synthetic', text: event.text, retryable: event.meta.retryable === true };
          } else if (event.text !== '') {
            yield { type: 'content', text: event.text };
          }
          break;
        case 'reasoning':
        case 'tool_calls':
          yield event;
          break;
        case 'finish':
          yield { type: 'finish', reason: event.reason };
          break;
        case 'error':
          throw new AliaChatError(event.message, {
            code: event.code,
            retryable: event.retryable,
            reference: event.reference,
          });
        case 'event': {
          const payload = asObject(event.data);
          if (payload === null) break;
          if (event.event === 'alia.reasoning') {
            if (typeof payload.content === 'string' && payload.content !== '') {
              yield { type: 'reasoning', text: payload.content };
            }
          } else if (event.event === 'alia.tool_result') {
            yield {
              type: 'tool_result',
              toolCallId: typeof payload.tool_call_id === 'string' ? payload.tool_call_id : '',
              name: typeof payload.name === 'string' ? payload.name : '',
              output: payload.output,
            };
          } else {
            yield { type: 'event', name: event.event, data: payload };
          }
          break;
        }
        case 'done':
          return;
      }
    }
  } catch (error) {
    if (error instanceof AliaStreamError) {
      throw new AliaChatError(
        error.failure === 'truncated'
          ? 'Alia’s response ended before it was complete.'
          : 'Alia’s response could not be read. Please try again.',
        {
          code: error.failure === 'truncated' ? 'STREAM_INCOMPLETE' : 'STREAM_INVALID',
          retryable: true,
        },
      );
    }
    throw error;
  }
}

/**
 * Whether a NON-streaming `chat.completion` body is the server's stand-in.
 *
 * `buildCompletionResponse` (`lib/chat/response-shapes.ts`) puts `alia_meta`
 * at the top level of the envelope; the inline-completion path reads
 * `choices[0].message.content` and would otherwise insert "I'm sorry, all
 * models are currently busy" into a source file as a code completion.
 */
export function isSyntheticCompletion(payload: unknown): boolean {
  const meta = asObject(asObject(payload)?.alia_meta);
  return meta?.synthetic === true;
}
