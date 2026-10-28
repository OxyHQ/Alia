/**
 * The client half of Alia's streaming dictation protocol,
 * `GET /v1/audio/transcriptions/stream` (ADR 0024).
 *
 * The server's copy is `packages/api/src/lib/dictation/protocol.ts`; the SDK
 * does not depend on the API package, so the shapes are restated here and
 * `DICTATION_PROTOCOL_VERSION` is what turns a mismatch into a refusal instead
 * of a misunderstanding. The API's tests hold the two copies equal.
 *
 * - Binary, client → Alia: microphone PCM16 LE, 24 kHz, mono.
 * - Text: one JSON event per frame, both ways.
 *
 * Segments are Alia's numbers, from 0, in the order the person spoke them. A
 * segment's `transcript.final` is the only text a client keeps:
 * `transcript.interim` (the segment's provisional text, whole, replacing the
 * last) and `transcript.delta` (locked text appended) are display state the
 * final supersedes.
 */

export const DICTATION_PROTOCOL_VERSION = 1;

export const DICTATION_STREAM_PATH = '/v1/audio/transcriptions/stream';

/** PCM16 mono at this rate: the one encoding the stream takes. */
export const DICTATION_SAMPLE_RATE = 24_000;

/** What a dictation ends with that is not a failure. */
export type DictationCloseReason =
  | 'ended'
  | 'max-duration'
  | 'idle-timeout'
  | 'error'
  | 'server-shutdown';

/** Why a dictation failed, as Alia names it. */
export type DictationStreamErrorCode =
  | 'TRANSCRIPTION_UNAVAILABLE'
  | 'TRANSCRIPTION_LIMITED'
  | 'TRANSCRIPTION_REJECTED'
  | 'TRANSCRIPTION_FAILED'
  | 'CLIP_TOO_LONG'
  | 'INVALID_REQUEST'
  | 'NOT_AUTHENTICATED'
  | 'CREDENTIAL_NOT_SUPPORTED';

export type DictationServerEvent =
  | { readonly type: 'dictation.ready'; readonly maxDurationMs: number }
  | { readonly type: 'transcript.interim'; readonly segment: number; readonly text: string }
  | { readonly type: 'transcript.delta'; readonly segment: number; readonly text: string }
  | { readonly type: 'transcript.final'; readonly segment: number; readonly text: string }
  | {
      readonly type: 'error';
      readonly code: DictationStreamErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly type: 'dictation.closed'; readonly reason: DictationCloseReason };

export type DictationClientEvent =
  | { readonly type: 'auth'; readonly token: string }
  | {
      readonly type: 'dictation.start';
      readonly protocol: number;
      readonly language?: string;
      readonly sampleRate: number;
    }
  | { readonly type: 'dictation.commit' }
  | { readonly type: 'dictation.end' };

const CLOSE_REASONS: ReadonlySet<string> = new Set<DictationCloseReason>([
  'ended',
  'max-duration',
  'idle-timeout',
  'error',
  'server-shutdown',
]);

const ERROR_CODES: ReadonlySet<string> = new Set<DictationStreamErrorCode>([
  'TRANSCRIPTION_UNAVAILABLE',
  'TRANSCRIPTION_LIMITED',
  'TRANSCRIPTION_REJECTED',
  'TRANSCRIPTION_FAILED',
  'CLIP_TOO_LONG',
  'INVALID_REQUEST',
  'NOT_AUTHENTICATED',
  'CREDENTIAL_NOT_SUPPORTED',
]);

const isSegment = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** One server text frame, or `null` when it is not one of protocol 1's events. */
export function parseDictationServerEvent(text: string): DictationServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'dictation.ready':
      return typeof event.maxDurationMs === 'number' && event.maxDurationMs > 0
        ? { type: 'dictation.ready', maxDurationMs: event.maxDurationMs }
        : null;
    case 'transcript.interim':
    case 'transcript.delta':
    case 'transcript.final':
      return isSegment(event.segment) && typeof event.text === 'string'
        ? { type: event.type, segment: event.segment, text: event.text }
        : null;
    case 'error':
      return typeof event.code === 'string' &&
        ERROR_CODES.has(event.code) &&
        typeof event.message === 'string'
        ? {
            type: 'error',
            code: event.code as DictationStreamErrorCode,
            message: event.message,
            retryable: event.retryable === true,
          }
        : null;
    case 'dictation.closed':
      return typeof event.reason === 'string' && CLOSE_REASONS.has(event.reason)
        ? { type: 'dictation.closed', reason: event.reason as DictationCloseReason }
        : null;
    default:
      return null;
  }
}

/** `wss://…/v1/audio/transcriptions/stream` for an Alia API origin. */
export function dictationStreamUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  const ws = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  return `${ws}${DICTATION_STREAM_PATH}`;
}
