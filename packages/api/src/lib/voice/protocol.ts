/**
 * Alia's voice-call protocol, `GET /v1/voice/session` (ADR 0017 §3, §4).
 *
 * A WebSocket the client opens on Alia. Alia is the only client of the Kaana
 * realtime session behind it: the device never sees an instruction, a tool
 * schema or a tool result, only audio, transcripts and the few events a call
 * UI draws.
 *
 * ## Frames
 *
 * - **Binary, client → Alia:** microphone audio, PCM16 little-endian, 24 kHz,
 *   mono, about 40 ms per frame. At most {@link MAX_CLIENT_AUDIO_FRAME_BYTES}.
 * - **Binary, Alia → client:** the assistant's audio, same format, prefixed by
 *   a header naming the assistant item it belongs to
 *   ({@link encodeAssistantAudioFrame}), so the client knows exactly how many
 *   milliseconds of WHICH item it played when it is interrupted.
 * - **Text:** one JSON event per frame. Every server event after
 *   `session.accepted` carries `seq`, monotonic per voice session, which is
 *   what `session.resume { afterSeq }` replays from.
 *
 * ## Opening
 *
 *   client: auth { token }                 (an Oxy session of Alia's own apps)
 *   alia:   auth.ok
 *   client: session.start { … }  |  session.resume { voiceSessionId, afterSeq }
 *   alia:   session.accepted { voiceSessionId, callId }      → still connecting
 *   alia:   session.ready { model, … }                        → Kaana created it
 *   client: <binary audio>…
 *   alia:   input.ready                                       → first audio appended
 *
 * The SDK says "listening" only after `session.ready`, its own first captured
 * buffer and `input.ready` (ADR 0017 §4, "Honest states").
 *
 * `auth` may be sent again at any time with a fresher token for the same
 * person; Alia then uses it for the tools that act with the person's bearer.
 *
 * `@alia.onl/sdk` keeps its own copy of these shapes (`src/lib/voice-protocol.ts`):
 * the SDK does not depend on the API package. `VOICE_PROTOCOL_VERSION` is what
 * makes a mismatch a refusal instead of a silent misunderstanding.
 */

/**
 * 2: every transcript and tool event names `messageId`, the message it belongs
 * to as it is stored. A version-1 client drew one bubble per audio item and
 * cannot read that, so it is refused rather than served wrongly.
 */
export const VOICE_PROTOCOL_VERSION = 2;

export const VOICE_SESSION_PATH = '/v1/voice/session';

/** PCM16 mono at this rate, both directions — Kaana's `pcm16_24khz`. */
export const VOICE_SAMPLE_RATE = 24_000;

/** Bytes per millisecond of PCM16 mono at {@link VOICE_SAMPLE_RATE}. */
export const VOICE_BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000;

/**
 * The largest microphone frame Alia accepts: the contract's bound on one
 * appended frame (49 152 bytes, about one second). The client sends ~40 ms.
 */
export const MAX_CLIENT_AUDIO_FRAME_BYTES = 49_152;

/** The product voices; the upstream voice id is chosen by Alia and never sent. */
export const PRODUCT_VOICES = ['male', 'female'] as const;
export type ProductVoice = (typeof PRODUCT_VOICES)[number];

/* -------------------------------------------------------------------------- */
/*  Client → Alia                                                              */
/* -------------------------------------------------------------------------- */

export type VoiceClientEvent =
  | { type: 'auth'; token: string }
  | {
      type: 'session.start';
      protocol: number;
      conversationId: string;
      agentId?: string;
      voice: ProductVoice;
      /** BCP 47, the app's language (`speech-locale.ts`). */
      locale: string;
    }
  | { type: 'session.resume'; protocol: number; voiceSessionId: string; afterSeq: number }
  /**
   * After `user.speech_started`, the client flushed its playback queue: this
   * is how much of `itemId` the person actually heard.
   */
  | { type: 'playback.interrupted'; itemId: string; playedMs: number }
  /** The person hung up, or the screen that held the call went away. */
  | { type: 'session.end' };

/* -------------------------------------------------------------------------- */
/*  Alia → client                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every failure a call can end with, as a code the app localizes
 * (`voice.errors.*`). Device failures (`mic-denied`, `mic-unavailable`,
 * `connection-lost`) are the SDK's own and never sent by Alia.
 */
export const VOICE_SERVER_ERROR_CODES = [
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
] as const;
export type VoiceServerErrorCode = (typeof VOICE_SERVER_ERROR_CODES)[number];

/** Why a call ended. `call-moved-elsewhere` is a reason, not an error. */
export const VOICE_CLOSE_REASONS = [
  'hangup',
  'call-moved-elsewhere',
  'max-duration',
  'idle-timeout',
  'credits-exhausted',
  'error',
  'server-shutdown',
] as const;
export type VoiceCloseReason = (typeof VOICE_CLOSE_REASONS)[number];

export type VoiceRole = 'user' | 'assistant';

export type VoiceSessionEvent =
  | { type: 'session.accepted'; voiceSessionId: string; callId: string }
  | {
      type: 'session.ready';
      /** The revision that serves the call. Names may be shown; the operator never is. */
      model: { id: string; displayName: string; publisher: string };
      maxDurationMs: number;
      idleTimeoutMs: number;
      /** How long a dropped socket may resume within. */
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
  /** No more audio will come for this assistant item. */
  | { type: 'assistant.audio_done'; itemId: string }
  /** A response ended; `itemId` is its audio item, when it spoke. */
  | {
      type: 'assistant.done';
      itemId: string | null;
      status: 'completed' | 'cancelled' | 'incomplete' | 'failed';
    }
  /** A tool runs in Alia. `name` is the tool's name, for the call UI's label only. */
  | { type: 'tool.started'; messageId: string; callId: string; name: string }
  | { type: 'tool.finished'; messageId: string; callId: string; name: string; ok: boolean }
  /** A tool filed an action for the person's OK; the card is in the conversation. */
  | { type: 'approval.requested'; toolName: string }
  /** Messages of the call were stored in the conversation. */
  | { type: 'messages.saved'; conversationId: string; messageIds: string[] }
  | { type: 'session.warning'; code: 'ending-soon'; remainingMs: number }
  /** Alia is re-opening the session upstream; the client shows reconnecting. */
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

/** A session event as sent: numbered. */
export type SequencedVoiceEvent = VoiceSessionEvent & { seq: number };

/** What Alia sends before a session exists. */
export type VoicePreSessionEvent =
  | { type: 'auth.ok' }
  | {
      type: 'error';
      code: VoiceServerErrorCode;
      message: string;
      retryable: boolean;
      reference: string;
    };

/* -------------------------------------------------------------------------- */
/*  Assistant audio frames                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `[u8 n][n bytes: item id, UTF-8][PCM16 LE]`. Item ids are at most 128
 * characters in the contract, so they fit one length byte once encoded unless
 * they are exotic; a longer id is refused rather than truncated (a truncated id
 * would make the client report playback against the wrong item).
 */
export function encodeAssistantAudioFrame(itemId: string, pcm: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(itemId);
  if (id.byteLength === 0 || id.byteLength > 255) {
    throw new RangeError('an assistant item id must encode to 1..255 bytes');
  }
  const frame = new Uint8Array(1 + id.byteLength + pcm.byteLength);
  frame[0] = id.byteLength;
  frame.set(id, 1);
  frame.set(pcm, 1 + id.byteLength);
  return frame;
}

export function decodeAssistantAudioFrame(
  frame: Uint8Array,
): { itemId: string; pcm: Uint8Array } | null {
  if (frame.byteLength < 2) return null;
  const length = frame[0]!;
  if (length === 0 || frame.byteLength < 1 + length) return null;
  const itemId = new TextDecoder().decode(frame.subarray(1, 1 + length));
  return { itemId, pcm: frame.subarray(1 + length) };
}

/* -------------------------------------------------------------------------- */
/*  Parsing what the client sent                                               */
/* -------------------------------------------------------------------------- */

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** A client event, or `null` for anything this protocol does not define. */
export function parseVoiceClientEvent(raw: string): VoiceClientEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'auth':
      return typeof event.token === 'string' &&
        event.token.length > 0 &&
        event.token.length < 16_384
        ? { type: 'auth', token: event.token }
        : null;
    case 'session.start': {
      if (typeof event.protocol !== 'number') return null;
      if (typeof event.conversationId !== 'string' || !ID_PATTERN.test(event.conversationId))
        return null;
      if (
        event.agentId !== undefined &&
        (typeof event.agentId !== 'string' || !ID_PATTERN.test(event.agentId))
      )
        return null;
      if (!PRODUCT_VOICES.includes(event.voice as ProductVoice)) return null;
      if (typeof event.locale !== 'string' || !LOCALE_PATTERN.test(event.locale)) return null;
      return {
        type: 'session.start',
        protocol: event.protocol,
        conversationId: event.conversationId,
        ...(event.agentId === undefined ? {} : { agentId: event.agentId as string }),
        voice: event.voice as ProductVoice,
        locale: event.locale,
      };
    }
    case 'session.resume':
      return typeof event.protocol === 'number' &&
        typeof event.voiceSessionId === 'string' &&
        ID_PATTERN.test(event.voiceSessionId) &&
        Number.isSafeInteger(event.afterSeq) &&
        (event.afterSeq as number) >= -1
        ? {
            type: 'session.resume',
            protocol: event.protocol,
            voiceSessionId: event.voiceSessionId,
            afterSeq: event.afterSeq as number,
          }
        : null;
    case 'playback.interrupted':
      return typeof event.itemId === 'string' &&
        event.itemId.length > 0 &&
        event.itemId.length <= 128 &&
        typeof event.playedMs === 'number' &&
        Number.isFinite(event.playedMs) &&
        event.playedMs >= 0
        ? { type: 'playback.interrupted', itemId: event.itemId, playedMs: event.playedMs }
        : null;
    case 'session.end':
      return { type: 'session.end' };
    default:
      return null;
  }
}
