/**
 * The client half of Alia's voice-call protocol, `GET /v1/voice/session`
 * (ADR 0017 §3–§4).
 *
 * The server's copy is `packages/api/src/lib/voice/protocol.ts`; the SDK does
 * not depend on the API package, so the shapes are restated here and
 * `VOICE_PROTOCOL_VERSION` is what turns a mismatch into a refusal instead of a
 * misunderstanding.
 *
 * - Binary, client → Alia: microphone PCM16 LE, 24 kHz, mono, ~40 ms a frame.
 * - Binary, Alia → client: `[u8 n][n bytes: assistant item id, UTF-8][PCM16 LE]`.
 * - Text: one JSON event per frame. Every server event after
 *   `session.accepted` carries `seq`; a resume replays from `afterSeq`.
 */

/**
 * 2: every transcript and tool event names `messageId`, the message it belongs
 * to as it is stored.
 */
export const VOICE_PROTOCOL_VERSION = 2;

export const VOICE_SESSION_PATH = '/v1/voice/session';

/** PCM16 mono at this rate, both directions. */
export const VOICE_SAMPLE_RATE = 24_000;

/** Samples in one ~40 ms microphone frame. */
export const VOICE_FRAME_SAMPLES = 960;

/** Milliseconds of audio in `bytes` of PCM16 mono at {@link VOICE_SAMPLE_RATE}. */
export function pcmBytesToMs(bytes: number): number {
  return (bytes / 2 / VOICE_SAMPLE_RATE) * 1000;
}

export type ProductVoice = 'male' | 'female';

/** Codes Alia ends a call with. */
export type VoiceServerErrorCode =
  | 'not-authenticated'
  | 'credential-not-supported'
  | 'plan-required'
  | 'credits-exhausted'
  | 'agent-unavailable'
  | 'invalid-request'
  | 'resume-unavailable'
  | 'realtime-unavailable'
  | 'realtime-limited'
  | 'realtime-rejected'
  | 'realtime-failed';

const SERVER_ERROR_CODES: ReadonlySet<string> = new Set<VoiceServerErrorCode>([
  'not-authenticated',
  'credential-not-supported',
  'plan-required',
  'credits-exhausted',
  'agent-unavailable',
  'invalid-request',
  'resume-unavailable',
  'realtime-unavailable',
  'realtime-limited',
  'realtime-rejected',
  'realtime-failed',
]);

/** Why a call ended. `call-moved-elsewhere` is a reason, never an error. */
export type VoiceCloseReason =
  | 'hangup'
  | 'call-moved-elsewhere'
  | 'max-duration'
  | 'idle-timeout'
  | 'credits-exhausted'
  | 'error'
  | 'server-shutdown';

const CLOSE_REASONS: ReadonlySet<string> = new Set<VoiceCloseReason>([
  'hangup',
  'call-moved-elsewhere',
  'max-duration',
  'idle-timeout',
  'credits-exhausted',
  'error',
  'server-shutdown',
]);

export type VoiceRole = 'user' | 'assistant';

export type VoiceClientEvent =
  | { type: 'auth'; token: string }
  | {
      type: 'session.start';
      protocol: number;
      conversationId: string;
      agentId?: string;
      voice: ProductVoice;
      locale: string;
    }
  | { type: 'session.resume'; protocol: number; voiceSessionId: string; afterSeq: number }
  | { type: 'playback.interrupted'; itemId: string; playedMs: number }
  | { type: 'session.end' };

export type VoiceServerEvent =
  | { type: 'auth.ok' }
  | { type: 'session.accepted'; voiceSessionId: string; callId: string }
  | {
      type: 'session.ready';
      model: { id: string; displayName: string; publisher: string };
      maxDurationMs: number;
      idleTimeoutMs: number;
      resumeWindowMs: number;
    }
  | { type: 'input.ready' }
  | { type: 'user.speech_started'; itemId: string }
  | { type: 'user.speech_stopped'; itemId: string }
  /**
   * `messageId` is the message the text belongs to, the id it is stored and
   * announced under: an assistant turn's items are one message.
   */
  | { type: 'transcript.delta'; role: VoiceRole; messageId: string; itemId: string; text: string }
  | { type: 'transcript.done'; role: VoiceRole; messageId: string; itemId: string; text: string }
  | { type: 'assistant.audio_done'; itemId: string }
  | {
      type: 'assistant.done';
      itemId: string | null;
      status: 'completed' | 'cancelled' | 'incomplete' | 'failed';
    }
  | { type: 'tool.started'; messageId: string; callId: string; name: string }
  | { type: 'tool.finished'; messageId: string; callId: string; name: string; ok: boolean }
  | { type: 'approval.requested'; toolName: string }
  | { type: 'messages.saved'; conversationId: string; messageIds: string[] }
  | { type: 'session.warning'; code: 'ending-soon'; remainingMs: number }
  | { type: 'session.reconnecting' }
  | { type: 'session.resumed'; afterSeq: number }
  | {
      type: 'error';
      code: VoiceServerErrorCode;
      message: string;
      retryable: boolean;
      reference: string;
    }
  | { type: 'session.closed'; reason: VoiceCloseReason };

/** A server event as received: numbered once a session exists. */
export type ReceivedVoiceEvent = VoiceServerEvent & { seq?: number };

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * A server event, or `null` for a frame this SDK does not understand — which
 * it ignores rather than guesses at.
 */
export function parseVoiceServerEvent(raw: string): ReceivedVoiceEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  const seq = isNumber(event.seq) ? { seq: event.seq } : {};
  switch (event.type) {
    case 'auth.ok':
    case 'input.ready':
    case 'session.reconnecting':
      return { type: event.type, ...seq };
    case 'session.accepted':
      return isString(event.voiceSessionId) && isString(event.callId)
        ? {
            type: 'session.accepted',
            voiceSessionId: event.voiceSessionId,
            callId: event.callId,
            ...seq,
          }
        : null;
    case 'session.ready': {
      const model = event.model as Record<string, unknown> | undefined;
      if (
        !model ||
        !isString(model.id) ||
        !isNumber(event.maxDurationMs) ||
        !isNumber(event.idleTimeoutMs) ||
        !isNumber(event.resumeWindowMs)
      )
        return null;
      return {
        type: 'session.ready',
        model: {
          id: model.id,
          displayName: isString(model.displayName) ? model.displayName : model.id,
          publisher: isString(model.publisher) ? model.publisher : '',
        },
        maxDurationMs: event.maxDurationMs,
        idleTimeoutMs: event.idleTimeoutMs,
        resumeWindowMs: event.resumeWindowMs,
        ...seq,
      };
    }
    case 'user.speech_started':
    case 'user.speech_stopped':
    case 'assistant.audio_done':
      return isString(event.itemId) ? { type: event.type, itemId: event.itemId, ...seq } : null;
    case 'transcript.delta':
    case 'transcript.done':
      return (event.role === 'user' || event.role === 'assistant') &&
        isString(event.messageId) &&
        isString(event.itemId) &&
        isString(event.text)
        ? {
            type: event.type,
            role: event.role,
            messageId: event.messageId,
            itemId: event.itemId,
            text: event.text,
            ...seq,
          }
        : null;
    case 'assistant.done':
      return event.itemId === null || isString(event.itemId)
        ? {
            type: 'assistant.done',
            itemId: event.itemId as string | null,
            status:
              event.status === 'cancelled' ||
              event.status === 'incomplete' ||
              event.status === 'failed'
                ? event.status
                : 'completed',
            ...seq,
          }
        : null;
    case 'tool.started':
      return isString(event.messageId) && isString(event.callId) && isString(event.name)
        ? {
            type: 'tool.started',
            messageId: event.messageId,
            callId: event.callId,
            name: event.name,
            ...seq,
          }
        : null;
    case 'tool.finished':
      return isString(event.messageId) && isString(event.callId) && isString(event.name)
        ? {
            type: 'tool.finished',
            messageId: event.messageId,
            callId: event.callId,
            name: event.name,
            ok: event.ok === true,
            ...seq,
          }
        : null;
    case 'approval.requested':
      return isString(event.toolName)
        ? { type: 'approval.requested', toolName: event.toolName, ...seq }
        : null;
    case 'messages.saved':
      return isString(event.conversationId) && Array.isArray(event.messageIds)
        ? {
            type: 'messages.saved',
            conversationId: event.conversationId,
            messageIds: event.messageIds.filter(isString),
            ...seq,
          }
        : null;
    case 'session.warning':
      return event.code === 'ending-soon' && isNumber(event.remainingMs)
        ? { type: 'session.warning', code: 'ending-soon', remainingMs: event.remainingMs, ...seq }
        : null;
    case 'session.resumed':
      return isNumber(event.afterSeq)
        ? { type: 'session.resumed', afterSeq: event.afterSeq, ...seq }
        : null;
    case 'error':
      return {
        type: 'error',
        // A code this SDK does not know is still a failure of the call upstream.
        code:
          isString(event.code) && SERVER_ERROR_CODES.has(event.code)
            ? (event.code as VoiceServerErrorCode)
            : 'realtime-failed',
        message: isString(event.message) ? event.message : '',
        retryable: event.retryable === true,
        reference: isString(event.reference) ? event.reference : '',
        ...seq,
      };
    case 'session.closed':
      return {
        type: 'session.closed',
        reason:
          isString(event.reason) && CLOSE_REASONS.has(event.reason)
            ? (event.reason as VoiceCloseReason)
            : 'error',
        ...seq,
      };
    default:
      return null;
  }
}

/** `[u8 n][n bytes: item id][PCM16]`, or `null` for a frame that is not one. */
export function decodeAssistantAudioFrame(
  frame: Uint8Array,
): { itemId: string; pcm: Uint8Array } | null {
  if (frame.byteLength < 2) return null;
  const length = frame[0]!;
  if (length === 0 || frame.byteLength < 1 + length) return null;
  const itemId = new TextDecoder().decode(frame.subarray(1, 1 + length));
  return { itemId, pcm: frame.subarray(1 + length) };
}

/** The test and dev counterpart: what the server sends. */
export function encodeAssistantAudioFrame(itemId: string, pcm: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(itemId);
  const frame = new Uint8Array(1 + id.byteLength + pcm.byteLength);
  frame[0] = id.byteLength;
  frame.set(id, 1);
  frame.set(pcm, 1 + id.byteLength);
  return frame;
}

/** `https://api.alia.onl` → `wss://api.alia.onl/v1/voice/session`. */
export function voiceSessionUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  const ws = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  return `${ws}${VOICE_SESSION_PATH}`;
}
