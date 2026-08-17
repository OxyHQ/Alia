/**
 * The OpenAI chat-completions dialect, as an adapter at the boundary — epic
 * #139 workstream 3.
 *
 * The contract normalizes once, at the edge, and records which public dialect
 * the customer used so the answer can be rendered back in it
 * (`request.ts`, `clientRequestMetadataSchema.apiFormat`). Alia's problem today
 * is the opposite: the OpenAI wire shape is not recorded anywhere, it is
 * CONSTRUCTED in at least four places on the streaming path
 * (`lib/chat/stream-runner.ts:195-199` and `:283`, `lib/streaming-helpers.ts`,
 * `lib/chat/provider-loop.ts:296-321`, `lib/chat/response-shapes.ts`).
 *
 * This module is the one place the dialect lives, in both directions. It is
 * NOT wired into those four sites: doing that is the mechanical edit the gap
 * analysis describes in §3.4, it rewrites the live streaming path, and #139
 * forbids this workstream from becoming the live path. What is here is the
 * translation itself, testable in isolation, so the rewiring PR moves call sites
 * rather than writing logic.
 *
 * `relay-client.ts` does not import this module, and must not: a client that
 * knew the dialect would be a client the dialect could leak into.
 */

import type {
  InferenceContentPart,
  InferenceContentSource,
  InferenceMessage,
  InferenceRequest,
  InferenceStreamEvent,
  InferenceStreamRouteSwitchEvent,
  InferenceStreamUsageEvent,
} from '@oxyhq/contracts';

import { CHAT_EVENT_VERSION } from '../chat-events.js';
import type { RelayRequestPayload } from './relay-request.js';

/* -------------------------------------------------------------------------- */
/*  The dialect                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The OpenAI-shaped request, declared here rather than imported.
 *
 * This is not a contract type and there is nothing in `@oxyhq/contracts` to
 * import for it: the whole point of `apiFormat` is that the dialect is a
 * customer-facing shape the contract deliberately does not model. Declared
 * strictly rather than reusing `lib/types.ts`'s `OpenAIMessage`, whose `content`
 * and `tool_calls` are `any` — an adapter typed `any` on both sides is a cast
 * wearing a function's clothes.
 */
export type OpenAIChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface OpenAITextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface OpenAIImagePart {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string; readonly detail?: 'auto' | 'low' | 'high' };
}

export interface OpenAIAudioPart {
  readonly type: 'input_audio';
  readonly input_audio: { readonly data: string; readonly format: string };
}

export interface OpenAIFilePart {
  readonly type: 'file';
  readonly file: {
    readonly file_data?: string;
    readonly file_url?: string;
    readonly filename?: string;
  };
}

export type OpenAIChatContentPart =
  | OpenAITextPart
  | OpenAIImagePart
  | OpenAIAudioPart
  | OpenAIFilePart;

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAIChatMessage {
  readonly role: OpenAIChatRole;
  readonly content?: string | readonly OpenAIChatContentPart[] | null;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly OpenAIToolCall[];
}

export interface OpenAIChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
    readonly strict?: boolean;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'function'; readonly function: { readonly name: string } };

export type OpenAIResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly json_schema: {
        readonly name: string;
        readonly schema: Record<string, unknown>;
        readonly strict?: boolean;
      };
    };

export interface OpenAIChatCompletionsRequest {
  readonly messages: readonly OpenAIChatMessage[];
  readonly temperature?: number;
  readonly top_p?: number;
  readonly frequency_penalty?: number;
  readonly presence_penalty?: number;
  readonly seed?: number;
  readonly stop?: string | readonly string[];
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly tools?: readonly OpenAIChatTool[];
  readonly tool_choice?: OpenAIToolChoice;
  readonly response_format?: OpenAIResponseFormat;
}

/** The public path this dialect is served on, recorded in `client.endpoint`. */
export const OPENAI_CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions';

/* -------------------------------------------------------------------------- */
/*  Request: dialect → normalized                                             */
/* -------------------------------------------------------------------------- */

const DATA_URL = /^data:([^;,]+);base64,(.*)$/;

/**
 * A `data:` URL becomes inline content and everything else becomes a fetched
 * URL.
 *
 * The distinction is the contract's (`inferenceContentSourceSchema`) and it is
 * not cosmetic: an inline part is bytes the customer already sent, while a URL
 * is a fetch the data plane performs on their behalf. Handing a `data:` URL to
 * the `url` branch would ask Relay to fetch a scheme it has no business
 * fetching.
 */
function contentSource(url: string): InferenceContentSource {
  const inline = DATA_URL.exec(url);
  if (inline === null) return { kind: 'url', url };
  return { kind: 'inline', mediaType: inline[1], data: inline[2] };
}

function contentParts(content: OpenAIChatMessage['content']): InferenceContentPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];

  const parts: InferenceContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      parts.push({
        type: 'image',
        source: contentSource(part.image_url.url),
        ...(part.image_url.detail === undefined ? {} : { detail: part.image_url.detail }),
      });
    } else if (part.type === 'input_audio') {
      parts.push({
        type: 'audio',
        source: {
          kind: 'inline',
          mediaType: `audio/${part.input_audio.format}`,
          data: part.input_audio.data,
        },
      });
    } else {
      const source =
        part.file.file_url !== undefined
          ? contentSource(part.file.file_url)
          : contentSource(part.file.file_data ?? '');
      parts.push({
        type: 'file',
        source,
        ...(part.file.filename === undefined ? {} : { filename: part.file.filename }),
      });
    }
  }
  return parts;
}

function normalizedMessage(message: OpenAIChatMessage): InferenceMessage {
  return {
    role: message.role,
    content: contentParts(message.content),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id }),
    ...(message.tool_calls === undefined
      ? {}
      : {
          toolCalls: message.tool_calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        }),
  };
}

function normalizedToolChoice(choice: OpenAIToolChoice): InferenceRequest['toolChoice'] {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

function normalizedResponseFormat(format: OpenAIResponseFormat): InferenceRequest['responseFormat'] {
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      name: format.json_schema.name,
      schema: format.json_schema.schema,
      // The contract requires the flag; OpenAI treats an absent one as false.
      strict: format.json_schema.strict ?? false,
    };
  }
  return { type: format.type };
}

/**
 * The whole of Alia's OpenAI surface, as one normalized payload.
 *
 * `max_completion_tokens` wins over `max_tokens` where both are present, which
 * is OpenAI's own precedence. `stop` collapses its two spellings into the
 * contract's list.
 *
 * `stream` is absent from the result on purpose: whether the wire streams is the
 * Relay client's, and a caller asking for `stream: false` gets a folded
 * completion rather than a different request.
 */
export function fromChatCompletionsRequest(
  body: OpenAIChatCompletionsRequest,
  options: { readonly clientRequestId?: string; readonly labels?: Record<string, string> } = {},
): RelayRequestPayload {
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  const stopSequences =
    body.stop === undefined ? undefined : typeof body.stop === 'string' ? [body.stop] : [...body.stop];

  return {
    modality: 'text',
    input: { format: 'messages', messages: body.messages.map(normalizedMessage) },
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    sampling: {
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { topP: body.top_p }),
      ...(body.frequency_penalty === undefined
        ? {}
        : { frequencyPenalty: body.frequency_penalty }),
      ...(body.presence_penalty === undefined ? {} : { presencePenalty: body.presence_penalty }),
      ...(body.seed === undefined ? {} : { seed: body.seed }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
    },
    tools: (body.tools ?? []).map((tool) => ({
      type: 'function',
      name: tool.function.name,
      ...(tool.function.description === undefined
        ? {}
        : { description: tool.function.description }),
      parameters: tool.function.parameters ?? {},
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
    })),
    ...(body.tool_choice === undefined
      ? {}
      : { toolChoice: normalizedToolChoice(body.tool_choice) }),
    ...(body.response_format === undefined
      ? {}
      : { responseFormat: normalizedResponseFormat(body.response_format) }),
    client: {
      apiFormat: 'chat_completions',
      endpoint: OPENAI_CHAT_COMPLETIONS_ENDPOINT,
      ...(options.clientRequestId === undefined
        ? {}
        : { clientRequestId: options.clientRequestId }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Response: normalized → dialect                                            */
/* -------------------------------------------------------------------------- */

export interface OpenAIChunkToolCall {
  readonly index: number;
  readonly id?: string;
  readonly type?: 'function';
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

export interface OpenAIChunkDelta {
  readonly role?: 'assistant';
  readonly content?: string;
  readonly refusal?: string;
  readonly tool_calls?: readonly OpenAIChunkToolCall[];
}

export interface OpenAIChunkChoice {
  readonly index: number;
  readonly delta: OpenAIChunkDelta;
  readonly finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChunkUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: { readonly cached_tokens: number };
  readonly completion_tokens_details: { readonly reasoning_tokens: number };
}

export interface OpenAIChatCompletionChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAIChunkChoice[];
  readonly usage?: OpenAIChunkUsage;
}

/**
 * `cancelled` has no OpenAI spelling, so it renders as `stop`.
 *
 * That is a lossy mapping and it is the right one: an OpenAI client has no
 * branch for a cancellation it initiated, and inventing a finish reason outside
 * the dialect's closed set would break the clients this adapter exists to serve.
 * The unlossy record is the contract's `done` event, which the caller still has.
 *
 * `refusal` is the same shape with a different neighbour: OpenAI carries a
 * model's refusal in the message's `refusal` field and still finishes the choice
 * as `stop`, so `stop` is the dialect's own answer here rather than a
 * concession — `content_filter` would claim a SAFETY SYSTEM intervened when the
 * model itself declined.
 */
const FINISH_REASON: Readonly<
  Record<
    Extract<InferenceStreamEvent, { type: 'done' }>['finishReason'],
    OpenAIChunkChoice['finish_reason']
  >
> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
  refusal: 'stop',
  cancelled: 'stop',
};

function chunkUsage(event: InferenceStreamUsageEvent): OpenAIChunkUsage {
  const quantity = (unit: InferenceStreamUsageEvent['units'][number]['unit']): number =>
    event.units.find((entry) => entry.unit === unit)?.quantity ?? 0;

  const prompt = quantity('input_tokens');
  const completion = quantity('output_tokens');
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    // The reason `cached_tokens` stops being the hardcoded zero at
    // `lib/chat/provider-loop.ts:309`: the contract meters it as its own unit.
    prompt_tokens_details: { cached_tokens: quantity('cached_input_tokens') },
    completion_tokens_details: { reasoning_tokens: quantity('reasoning_tokens') },
  };
}

/**
 * Renders one Alia turn's contract events as OpenAI chunks.
 *
 * Stateful because the dialect is: OpenAI identifies a streamed tool call by a
 * positional `index` that the contract does not carry, so the first event for a
 * given `toolCallId` is what assigns one. A pure function would have to
 * re-derive that index from nothing.
 *
 * Returns `null` for every event the dialect cannot express — `start`,
 * `route_switch`, `error` and the reasoning channel. Those are Alia extension
 * events (see {@link renderRouteSwitchEvent} and `lib/chat-events.ts`), and
 * `null` is the honest answer rather than an empty chunk, which a client would
 * render as a blank token.
 */
export class ChatCompletionsRenderer {
  private readonly toolCallIndex = new Map<string, number>();

  constructor(
    private readonly frame: { readonly id: string; readonly model: string; readonly created: number },
  ) {}

  render(event: InferenceStreamEvent): OpenAIChatCompletionChunk | null {
    switch (event.type) {
      case 'delta': {
        if (event.channel === 'reasoning') return null;
        const delta: OpenAIChunkDelta =
          event.channel === 'refusal' ? { refusal: event.text } : { content: event.text };
        return this.chunk([{ index: 0, delta, finish_reason: null }]);
      }
      case 'tool_call': {
        let index = this.toolCallIndex.get(event.toolCallId);
        const first = index === undefined;
        if (index === undefined) {
          index = this.toolCallIndex.size;
          this.toolCallIndex.set(event.toolCallId, index);
        }
        const call: OpenAIChunkToolCall = {
          index,
          ...(first ? { id: event.toolCallId, type: 'function' as const } : {}),
          function: {
            ...(event.name === undefined ? {} : { name: event.name }),
            ...(event.argumentsDelta === undefined ? {} : { arguments: event.argumentsDelta }),
          },
        };
        return this.chunk([{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }]);
      }
      case 'usage':
        return { ...this.chunk([]), usage: chunkUsage(event) };
      case 'done':
        return this.chunk([
          { index: 0, delta: {}, finish_reason: FINISH_REASON[event.finishReason] },
        ]);
      case 'start':
      case 'route_switch':
      case 'error':
        return null;
    }
  }

  private chunk(choices: readonly OpenAIChunkChoice[]): OpenAIChatCompletionChunk {
    return {
      id: this.frame.id,
      object: 'chat.completion.chunk',
      created: this.frame.created,
      model: this.frame.model,
      choices,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  The route-switch extension event                                          */
/* -------------------------------------------------------------------------- */

/**
 * A route switch is a NEW Alia SSE event, and deliberately not `alia.model_switch`.
 *
 * `alia.model_switch` (`lib/chat-events.ts`, emitted at `lib/tool-pipeline.ts:122`)
 * fires when the model calls the `switchModel` tool to change the
 * conversation's Alia model — a deliberate, user-visible product feature.
 * Mapping the contract's `route_switch` onto it would render a failover notice
 * as a model-picker change in the user's UI.
 */
export const ALIA_ROUTE_SWITCH_EVENT = 'alia.route_switch';

export interface AliaRouteSwitchPayload {
  readonly eventVersion: typeof CHAT_EVENT_VERSION;
  readonly reason: InferenceStreamRouteSwitchEvent['reason'];
  readonly scope: InferenceStreamRouteSwitchEvent['detail']['scope'];
  readonly occurredAt: InferenceStreamRouteSwitchEvent['occurredAt'];
}

/**
 * What a user is told about a switch: that it happened, why, and how far.
 *
 * Every identifying field of the contract event is dropped, and that is the
 * model-abstraction rule rather than brevity. `detail.toProvider` is a provider
 * slug and `detail.toModelReference` is `<publisher>/<model>`, whose publisher
 * is a provider name — both are exactly what Alia must never put in an API
 * response (`AGENTS.md`, "Model abstraction"). The contract carries provider
 * identity as DATA so the platform can reconcile a charge; Alia's rule governs
 * what is RENDERED, and the two only stay compatible if the rendering drops it.
 */
export function renderRouteSwitchEvent(
  event: InferenceStreamRouteSwitchEvent,
): AliaRouteSwitchPayload {
  return {
    eventVersion: CHAT_EVENT_VERSION,
    reason: event.reason,
    scope: event.detail.scope,
    occurredAt: event.occurredAt,
  };
}
