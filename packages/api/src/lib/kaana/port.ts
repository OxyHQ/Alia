/**
 * The part of `@kaana.ai/sdk` 1.0.0 Alia's voice uses, as a PORT.
 *
 * Kaana ADR 0002 ("Superficie del SDK") fixes the client's shape:
 * `models.list`, `realtime.connect(open): RealtimeSession` with `send`,
 * `appendAudio(pcm16)`, `resume()` and `close(): Usage`, and
 * `audio.transcriptions.create`. The SDK is being built in parallel and is not
 * on npm yet, nor is `@kaana.ai/contracts`; so this file restates — narrowly —
 * the shapes Alia reads and writes, copied from `@kaana.ai/contracts` 4.0.0
 * (`packages/contracts/src/public/{realtime,catalogue,audio,money,errors}.ts`
 * on Kaana's `feat/kaana-contracts`). When the packages are published these
 * declarations become `import type * as C from '@kaana.ai/contracts'` and the
 * real `Kaana` class satisfies {@link KaanaClient} structurally;
 * `kaana/transport.ts` is the one place that constructs it.
 *
 * Every shape here is the contract's PUBLIC shape. Nothing names a provider,
 * a deployment or a key: Alia never learns which operator served a call.
 *
 * ## Errors are recognized by their fields, not by class identity
 *
 * The SDK throws `KaanaError` subclasses with a public `code`. Alia classifies
 * them by `code` ({@link kaanaErrorOf}) rather than `instanceof`, so the real
 * SDK's classes, the fake's and anything that crosses a module duplicate are
 * read the same way, with no mapping layer in the transport.
 */

import type { UsageUnit } from '@kaana.ai/contracts';

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** `@kaana.ai/contracts` `PUBLIC_ERROR_CODES`. */
export const KAANA_PUBLIC_ERROR_CODES = [
  'invalid_request',
  'authentication_failed',
  'permission_denied',
  'insufficient_scope',
  'model_not_found',
  'unsupported_modality',
  'context_length_exceeded',
  'request_too_large',
  'output_limit_exceeded',
  'idempotency_conflict',
  'insufficient_balance',
  'spending_limit_exceeded',
  'quota_exceeded',
  'byok_credential_invalid',
  'policy_violation',
  'commercial_permission_denied',
  'no_route_available',
  'upstream_content_filtered',
  'cancelled',
  'rate_limited',
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'service_unavailable',
  'internal_error',
] as const;
export type KaanaPublicErrorCode = (typeof KAANA_PUBLIC_ERROR_CODES)[number];

/** The fields `KaanaError` carries (ADR 0002). */
export interface KaanaErrorFields {
  readonly code: KaanaPublicErrorCode;
  readonly message: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly param?: string;
  readonly afterOutput: boolean;
}

/** The public error body a stream's terminal `error` event carries. */
export interface KaanaPublicError {
  schemaVersion: 1;
  code: KaanaPublicErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
  retryAfterMs?: number;
  param?: string;
}

const CODES: ReadonlySet<string> = new Set(KAANA_PUBLIC_ERROR_CODES);

/**
 * What a thrown value says, if it is one of the SDK's typed failures.
 *
 * - a `KaanaError` (any subclass): its fields;
 * - `KaanaConnectionError` (network or timeout before any response):
 *   `connection`;
 * - `KaanaProtocolError` (a response that breaks the contract): `protocol`;
 * - anything else: `null`.
 */
export function kaanaErrorOf(
  error: unknown,
):
  | ({ kind: 'kaana' } & KaanaErrorFields)
  | { kind: 'connection'; timedOut: boolean }
  | { kind: 'protocol' }
  | null {
  if (error === null || typeof error !== 'object') return null;
  const candidate = error as Partial<KaanaErrorFields> & { name?: unknown; timedOut?: unknown };
  if (typeof candidate.code === 'string' && CODES.has(candidate.code)) {
    return {
      kind: 'kaana',
      code: candidate.code as KaanaPublicErrorCode,
      message: typeof candidate.message === 'string' ? candidate.message : '',
      status: typeof candidate.status === 'number' ? candidate.status : null,
      requestId: typeof candidate.requestId === 'string' ? candidate.requestId : null,
      retryable: candidate.retryable === true,
      ...(typeof candidate.retryAfterMs === 'number'
        ? { retryAfterMs: candidate.retryAfterMs }
        : {}),
      ...(typeof candidate.param === 'string' ? { param: candidate.param } : {}),
      afterOutput: candidate.afterOutput === true,
    };
  }
  if (candidate.name === 'KaanaConnectionError') {
    return { kind: 'connection', timedOut: candidate.timedOut === true };
  }
  if (candidate.name === 'KaanaProtocolError') return { kind: 'protocol' };
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Money and usage (`public/money.ts`)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every unit Kaana meters, from the published contract rather than a copy: the
 * restated list missed `input_transcription_milliseconds` (contracts 4.1.0) and
 * the real SDK stopped satisfying this port. A unit Kaana adds is a dependency
 * bump, never a silent mismatch.
 */
export type KaanaUsageUnit = UsageUnit;

export interface KaanaUsageQuantity {
  unit: KaanaUsageUnit;
  quantity: number;
}

/** `usageSchema`: one quantity per unit; the units partition the request. */
export type KaanaUsage = KaanaUsageQuantity[];

export interface KaanaUnitPrice {
  unit: KaanaUsageUnit;
  /** An exact decimal string. */
  amount: string;
  per: number;
  currency: string;
}

export interface KaanaPriceSnapshot {
  priceVersionId: string;
  currency: string;
  unitPrices: KaanaUnitPrice[];
}

/* -------------------------------------------------------------------------- */
/*  Catalogue (`public/catalogue.ts`)                                          */
/* -------------------------------------------------------------------------- */

export type KaanaApiFormat =
  | 'responses'
  | 'chat_completions'
  | 'embeddings'
  | 'decisions'
  | 'images_generations'
  | 'audio_transcriptions'
  | 'audio_speech'
  | 'rerank'
  | 'batches';

export type KaanaAudioInputMediaType =
  | 'audio/mpeg'
  | 'audio/mp4'
  | 'audio/wav'
  | 'audio/ogg'
  | 'audio/webm'
  | 'audio/flac'
  | 'audio/aac'
  | 'audio/pcm';

export interface KaanaVoice {
  id: string;
  name: string;
  languages: string[];
  gender?: 'female' | 'male' | 'neutral';
}

export interface KaanaModel {
  schemaVersion: 1;
  /** `publisher/model`. */
  modelId: string;
  publisher: { slug: string; displayName: string };
  displayName: string;
  currentRevision: string;
  capabilities: {
    inputModalities: string[];
    outputModalities: string[];
    tools: boolean;
    apiFormats?: KaanaApiFormat[];
    realtime?: {
      transports: Array<'websocket'>;
      sessionKinds: Array<'conversation' | 'transcription' | 'translation'>;
      /**
       * The model transcribes its own input inside a `conversation` session
       * (`config.inputAudioTranscription`), metered in the session.
       *
       * NOT in `@kaana.ai/contracts` 4.0.0: it is the catalogue flag Kaana's
       * phase-1 work adds (Alia ADR 0017 §2, §6), and its final name is
       * Kaana's to choose. Alia reads it under this name until then; a model
       * without it is not a voice candidate, because the person's words become
       * messages of the conversation.
       */
      inputAudioTranscription?: boolean;
    };
  };
  audio?: {
    voices: KaanaVoice[];
    languages: string[];
    audioFormats: { input: KaanaAudioInputMediaType[]; output: string[] };
  };
  releasedAt?: string;
  pricing?: KaanaPriceSnapshot;
  deprecation: { status: 'active' | 'deprecated' | 'retired' };
  powerClass?: string;
}

/* -------------------------------------------------------------------------- */
/*  Realtime (`public/realtime.ts`)                                            */
/* -------------------------------------------------------------------------- */

export type KaanaRealtimeAudioFormat = 'pcm16_24khz' | 'g711_ulaw' | 'g711_alaw';

export interface KaanaToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type KaanaTurnDetection =
  | { type: 'none' }
  | {
      type: 'server_vad';
      threshold?: number;
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
      createResponse: boolean;
      interruptResponse: boolean;
    }
  | {
      type: 'semantic_vad';
      eagerness: 'low' | 'medium' | 'high' | 'auto';
      createResponse: boolean;
      interruptResponse: boolean;
    };

export interface KaanaRealtimeSessionConfig {
  instructions?: string;
  outputModalities?: Array<'text' | 'audio'>;
  voice?: string;
  inputAudioFormat: KaanaRealtimeAudioFormat;
  outputAudioFormat?: KaanaRealtimeAudioFormat;
  turnDetection: KaanaTurnDetection;
  inputAudioTranscription?: { language?: string; prompt?: string };
  tools?: KaanaToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  temperature?: number;
  maxOutputTokens?: number;
}

export type KaanaRealtimeSessionConfigUpdate = Partial<
  Omit<KaanaRealtimeSessionConfig, 'voice' | 'inputAudioFormat' | 'outputAudioFormat'>
>;

export interface KaanaRealtimeSessionLimits {
  maxDurationMs: number;
  idleTimeoutMs: number;
  maxInputAudioBytes: number;
  maxOutputAudioBytes: number;
  maxResponses: number;
}

/** `realtimeSessionOpenSchema`. */
export interface KaanaRealtimeSessionOpen {
  type: 'session.open';
  kind: 'conversation' | 'transcription' | 'translation';
  transport?: 'websocket';
  config: KaanaRealtimeSessionConfig;
  limits?: Partial<KaanaRealtimeSessionLimits>;
  clientSessionId?: string;
  labels?: Record<string, string>;
}

/**
 * What `realtime.connect` is given: the open frame plus the model it opens on.
 *
 * ADR 0002 writes `connect(open: RealtimeSessionOpen)`, but the model is not a
 * field of the open frame: it travels on the URL (`GET /v1/realtime?model=`).
 * Alia passes it beside the frame as `model`; if the published SDK spells it
 * differently, `kaana/transport.ts` is where that is adapted.
 */
export type KaanaRealtimeConnectRequest = KaanaRealtimeSessionOpen & { model: string };

/** The contract caps `instructions` at this many characters. */
export const KAANA_MAX_REALTIME_INSTRUCTIONS = 32_768;
/** And a session's tools at this many. */
export const KAANA_MAX_REALTIME_TOOLS = 128;

export type KaanaRealtimeConversationItem =
  | {
      type: 'message';
      itemId?: string;
      role: 'system' | 'user' | 'assistant';
      content: Array<
        | { type: 'input_text'; text: string }
        | {
            type: 'input_audio';
            format: KaanaRealtimeAudioFormat;
            data?: string;
            transcript?: string;
          }
        | { type: 'output_text'; text: string }
        | { type: 'output_audio'; format: KaanaRealtimeAudioFormat; transcript?: string }
      >;
    }
  | { type: 'function_call'; itemId?: string; callId: string; name: string; arguments: string }
  | { type: 'function_call_output'; itemId?: string; callId: string; output: string };

interface CommandBase {
  schemaVersion: 1;
  requestId: string;
  commandId: string;
}

/** `realtimeClientCommandSchema` (what `RealtimeSession.send` takes). */
export type KaanaRealtimeClientEvent = CommandBase &
  (
    | { type: 'session.update'; config: KaanaRealtimeSessionConfigUpdate }
    | {
        type: 'conversation.item.create';
        previousItemId?: string;
        item: KaanaRealtimeConversationItem;
      }
    | { type: 'conversation.item.delete'; itemId: string }
    | {
        type: 'conversation.item.truncate';
        itemId: string;
        contentIndex: number;
        audioEndMs: number;
      }
    | { type: 'input_audio.append'; data: string }
    | { type: 'input_audio.commit' }
    | { type: 'input_audio.clear' }
    | {
        type: 'response.create';
        response?: {
          instructions?: string;
          outputModalities?: Array<'text' | 'audio'>;
          maxOutputTokens?: number;
        };
      }
    | { type: 'response.cancel'; responseId?: string }
    | { type: 'session.resume'; afterSequence: number }
    | { type: 'session.close' }
  );

/** A `KaanaRealtimeClientEvent` before the SDK numbers it. */
export type KaanaRealtimeCommand = DistributiveOmit<KaanaRealtimeClientEvent, keyof CommandBase>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface EventBase {
  schemaVersion: 1;
  requestId: string;
  sequence: number;
  commandId?: string;
}

export type KaanaRealtimeResponseStatus = 'completed' | 'cancelled' | 'incomplete' | 'failed';

export type KaanaRealtimeCloseReason =
  | 'client_closed'
  | 'max_duration'
  | 'idle_timeout'
  | 'limit_exceeded'
  | 'resume_expired'
  | 'upstream_closed'
  | 'upstream_error'
  | 'no_route_available'
  | 'server_shutdown';

/** `realtimePublicServerEventSchema`. */
export type KaanaRealtimeServerEvent = EventBase &
  (
    | {
        type: 'session.created';
        model: string;
        kind: 'conversation' | 'transcription' | 'translation';
        config: KaanaRealtimeSessionConfig;
        limits: KaanaRealtimeSessionLimits;
        resumeWindowMs: number;
        startedAt: string;
        expiresAt: string;
      }
    | { type: 'session.updated'; config: KaanaRealtimeSessionConfig }
    | { type: 'session.resumed'; afterSequence: number }
    | { type: 'command.accepted'; commandId: string; duplicate: boolean }
    | {
        type: 'conversation.item.added';
        itemId: string;
        previousItemId?: string;
        item: KaanaRealtimeConversationItem;
      }
    | { type: 'conversation.item.done'; itemId: string; item: KaanaRealtimeConversationItem }
    | { type: 'conversation.item.deleted'; itemId: string }
    | {
        type: 'conversation.item.truncated';
        itemId: string;
        contentIndex: number;
        audioEndMs: number;
      }
    | { type: 'input_audio.speech_started'; itemId: string; audioStartMs: number }
    | { type: 'input_audio.speech_stopped'; itemId: string; audioEndMs: number }
    | { type: 'input_audio.committed'; itemId: string; previousItemId?: string }
    | { type: 'input_audio.cleared' }
    | { type: 'response.created'; responseId: string }
    | {
        type: 'output_audio.delta';
        responseId: string;
        itemId: string;
        contentIndex: number;
        format: KaanaRealtimeAudioFormat;
        /** Base64. */
        data: string;
      }
    | { type: 'output_audio.done'; responseId: string; itemId: string; contentIndex: number }
    | {
        type: 'transcript.delta';
        source: 'input_audio' | 'output_audio';
        itemId: string;
        contentIndex: number;
        responseId?: string;
        text: string;
      }
    | {
        type: 'transcript.done';
        source: 'input_audio' | 'output_audio';
        itemId: string;
        contentIndex: number;
        responseId?: string;
        transcript: string;
      }
    | {
        type: 'text.delta';
        responseId: string;
        itemId: string;
        contentIndex: number;
        text: string;
      }
    | {
        type: 'tool_call';
        responseId: string;
        itemId: string;
        toolCallId: string;
        name?: string;
        argumentsDelta?: string;
        complete: boolean;
      }
    | {
        type: 'response.done';
        responseId: string;
        status: KaanaRealtimeResponseStatus;
        finishReason?: string;
        units: KaanaUsage;
        usageSource: 'provider_reported' | 'oxy_measured' | 'estimated';
      }
    | { type: 'error'; fatal: boolean; error: KaanaPublicError }
    | {
        type: 'session.closed';
        reason: KaanaRealtimeCloseReason;
        units: KaanaUsage;
        usageSource: 'provider_reported' | 'oxy_measured' | 'estimated';
        closedAt: string;
      }
  );

/** ADR 0002 `RealtimeSession`. */
export interface KaanaRealtimeSession extends AsyncIterable<KaanaRealtimeServerEvent> {
  readonly sessionId: string;
  /** A whole command: the caller numbers it (`requestId`, `commandId`). */
  send(event: KaanaRealtimeClientEvent): void;
  appendAudio(pcm16: Uint8Array): void;
  /** Re-attach within Kaana's window (30 s); rejects when it cannot. */
  resume(): Promise<void>;
  /** Settles exactly once; resolves with the session's units. */
  close(): Promise<KaanaUsage>;
}

/* -------------------------------------------------------------------------- */
/*  Transcription (`public/audio.ts`)                                          */
/* -------------------------------------------------------------------------- */

export interface KaanaTranscriptionRequest {
  model: string;
  file: Blob | Uint8Array;
  mediaType: KaanaAudioInputMediaType;
  language?: string;
  prompt?: string;
  timestamps?: 'none' | 'segment' | 'word';
}

export interface KaanaTranscription {
  schemaVersion: 1;
  requestId: string;
  model: string;
  text: string;
  language?: string;
  durationMs?: number;
  usage: KaanaUsage;
}

/** The largest upload a transcription request takes (`MAX_TRANSCRIPTION_FILE_BYTES`). */
export const KAANA_MAX_TRANSCRIPTION_FILE_BYTES = 20 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*  The client                                                                 */
/* -------------------------------------------------------------------------- */

/** ADR 0002 `RequestOptions`. */
export interface KaanaRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  /** `X-Oxy-User-Id`: delegated attribution under Alia's service token. */
  onBehalfOfUserId?: string;
  timeoutMs?: number;
}

/** What Alia's voice needs of `new Kaana(...)`. */
export interface KaanaClient {
  readonly models: {
    list(options?: KaanaRequestOptions): Promise<KaanaModel[]>;
  };
  readonly realtime: {
    connect(
      request: KaanaRealtimeConnectRequest,
      options?: KaanaRequestOptions,
    ): Promise<KaanaRealtimeSession>;
  };
  readonly audio: {
    readonly transcriptions: {
      create(
        request: KaanaTranscriptionRequest,
        options?: KaanaRequestOptions,
      ): Promise<KaanaTranscription>;
    };
  };
}
