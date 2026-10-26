/** CLI presentation and tool assembly over the published Alia wire reader. */
import {
  AliaServerClient,
  AliaRequestError,
  AliaStreamError,
  type AliaChatCompletionRequest,
  type AliaToolCallDelta,
} from '@alia.onl/server';

export type ToolCallDelta = AliaToolCallDelta;
export interface StreamedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type AliaStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; deltas: readonly ToolCallDelta[] }
  | { type: 'tool_result'; toolCallId: string; name: string; output: unknown }
  | { type: 'synthetic'; text: string; retryable: boolean }
  | { type: 'finish'; reason: string }
  | { type: 'event'; name: string; data: unknown };

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

export interface AliaChatStreamOptions {
  readonly baseUrl: string;
  readonly body: AliaChatCompletionRequest;
  readonly signal?: AbortSignal;
  readonly fetch: typeof fetch;
  /** Share one instance with createAliaTurnControl; credentials still belong to linked.fetch. */
  readonly client?: AliaServerClient;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function* streamAliaChat(
  options: AliaChatStreamOptions,
): AsyncGenerator<AliaStreamEvent> {
  const client =
    options.client ??
    new AliaServerClient({
      baseUrl: options.baseUrl,
      path: '/alia/chat',
      fetch: options.fetch,
    });
  try {
    const events = await client.stream(options.body, { signal: options.signal });
    for await (const event of events) {
      switch (event.type) {
        case 'text':
          yield event.meta?.synthetic === true
            ? { type: 'synthetic', text: event.text, retryable: event.meta.retryable === true }
            : { type: 'content', text: event.text };
          break;
        case 'reasoning':
        case 'tool_calls':
          yield event;
          break;
        case 'finish':
          if (event.meta?.synthetic === true)
            yield { type: 'synthetic', text: '', retryable: event.meta.retryable === true };
          yield event;
          break;
        case 'event': {
          const data = object(event.data);
          if (event.event === 'alia.reasoning' && typeof data?.content === 'string') {
            yield { type: 'reasoning', text: data.content };
          } else if (event.event === 'alia.tool_result') {
            yield {
              type: 'tool_result',
              toolCallId: typeof data?.tool_call_id === 'string' ? data.tool_call_id : '',
              name: typeof data?.name === 'string' ? data.name : '',
              output: data?.output,
            };
          } else yield { type: 'event', name: event.event, data: event.data };
          break;
        }
        case 'error':
          throw new AliaChatError(event.message, {
            code: event.code,
            retryable: event.retryable,
            reference: event.reference,
          });
        case 'done':
          return;
      }
    }
  } catch (error) {
    if (error instanceof AliaStreamError && error.failure === 'truncated') {
      throw new AliaChatError('Alia’s response ended before it was complete.', {
        code: 'STREAM_INCOMPLETE',
        retryable: true,
      });
    }
    if (error instanceof AliaRequestError) {
      throw new AliaChatError(error.message, {
        status: error.status,
        code: error.code,
        retryable: error.retryable ?? false,
        reference: error.reference,
      });
    }
    throw error;
  }
}
