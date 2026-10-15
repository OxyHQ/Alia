/**
 * Speech out: ask `POST /v1/audio/speech` for a clip, and play one.
 *
 * Shared by read-aloud (`useTTS`) and voice mode (`useVoiceRoom`) so both speak
 * through the one route Alia has for it — Alia → Oxy → Kaana, billed by Oxy per
 * call — with the same request body and the same error copy. Voice names are
 * the PRODUCT's (`male` / `female`); the route maps them, and no upstream voice
 * name ever appears on this side.
 */

import { createAudioLevelMeter } from './audio-level';

export type ProductVoice = 'male' | 'female';

export interface SpeechClipRequest {
  readonly apiUrl: string;
  readonly token: string;
  /** A speech model; omitted, the server's own speech model answers. */
  readonly model?: string;
  readonly input: string;
  readonly voice: ProductVoice;
  readonly speed?: number;
  /** Both or neither: the route stores the clip on that message when given. */
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly signal: AbortSignal;
}

/**
 * The codes `/v1/audio/speech` answers a failure with, plus the two this side
 * knows on its own: `NOT_AUTHENTICATED` (no session token, or the route said
 * 401) and `INVALID_REQUEST` (the route refused the body).
 */
export type SpeechClipErrorCode =
  | 'SPEECH_UNAVAILABLE'
  | 'SPEECH_REJECTED'
  | 'SPEECH_LIMIT_REACHED'
  | 'SPEECH_PROVIDER_FAILED'
  | 'SPEECH_GENERATION_FAILED'
  | 'INVALID_REQUEST'
  | 'NOT_AUTHENTICATED';

const SERVER_CODES: ReadonlySet<string> = new Set<SpeechClipErrorCode>([
  'SPEECH_UNAVAILABLE',
  'SPEECH_REJECTED',
  'SPEECH_LIMIT_REACHED',
  'SPEECH_PROVIDER_FAILED',
  'SPEECH_GENERATION_FAILED',
  'INVALID_REQUEST',
]);

/**
 * A clip that could not be made, with what the route said about it: the HTTP
 * status (`null` when no request was answered) and its typed `code` (`null`
 * when the route named none this SDK knows — a network failure, an older or
 * newer server).
 */
export class SpeechClipError extends Error {
  readonly status: number | null;
  readonly code: SpeechClipErrorCode | null;
  readonly retryable: boolean;
  /** Oxy's request id, for support, when the route gave one. */
  readonly requestId: string | null;

  constructor(
    message: string,
    details: {
      status: number | null;
      code: SpeechClipErrorCode | null;
      retryable?: boolean;
      requestId?: string | null;
    },
  ) {
    super(message);
    this.name = 'SpeechClipError';
    this.status = details.status;
    this.code = details.code;
    this.retryable = details.retryable ?? false;
    this.requestId = details.requestId ?? null;
  }
}

function clipErrorFrom(status: number, body: unknown): SpeechClipError {
  const envelope =
    body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const error =
    envelope !== null && typeof envelope === 'object'
      ? (envelope as {
          code?: unknown;
          message?: unknown;
          retryable?: unknown;
          requestId?: unknown;
        })
      : {};
  const named =
    typeof error.code === 'string' && SERVER_CODES.has(error.code)
      ? (error.code as SpeechClipErrorCode)
      : null;
  const code = named ?? (status === 401 ? 'NOT_AUTHENTICATED' : null);
  const message =
    status === 504
      ? 'Request timed out — please try again'
      : typeof error.message === 'string' && error.message !== ''
        ? error.message
        : typeof envelope === 'string' && envelope !== ''
          ? envelope
          : 'TTS failed';
  return new SpeechClipError(message, {
    status,
    code,
    retryable: error.retryable === true,
    requestId: typeof error.requestId === 'string' ? error.requestId : null,
  });
}

/**
 * Synthesize `input` and return the private link the route answers with.
 *
 * @throws {SpeechClipError} when the route refuses or answers no link; a
 *   network failure or an abort is thrown as `fetch` threw it.
 */
export async function requestSpeechClip(request: SpeechClipRequest): Promise<string> {
  if (request.token === '')
    throw new SpeechClipError('Not authenticated', { status: null, code: 'NOT_AUTHENTICATED' });
  const response = await fetch(`${request.apiUrl}/v1/audio/speech`, {
    method: 'POST',
    signal: request.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.token}`,
    },
    body: JSON.stringify({
      model: request.model,
      input: request.input,
      voice: request.voice,
      speed: request.speed,
      conversationId: request.conversationId,
      messageId: request.messageId,
    }),
  });

  if (!response.ok) {
    throw clipErrorFrom(response.status, await response.json().catch(() => null));
  }

  const data = (await response.json().catch(() => ({}))) as { audioUrl?: unknown };
  request.signal.throwIfAborted();
  if (typeof data.audioUrl !== 'string' || data.audioUrl === '')
    throw new SpeechClipError('TTS failed', { status: response.status, code: null });
  return data.audioUrl;
}

export interface PlayClipOptions {
  readonly signal: AbortSignal;
  /** The clip's live level, 0..1, where the platform lets playback be sampled. */
  readonly onLevel?: (level: number) => void;
}

/**
 * Play one clip to its end.
 *
 * Resolves when it finishes or when `signal` aborts (the player is released
 * either way — an interrupted answer stops at once), and rejects if the player
 * reports an error. `crossOrigin` and sampling are set as `useTTS` sets them;
 * its comments explain why.
 */
export async function playSpeechClip(uri: string, options: PlayClipOptions): Promise<void> {
  const { signal, onLevel } = options;
  if (signal.aborted) return;
  const { createAudioPlayer } = await import('expo-audio');
  if (signal.aborted) return;

  const player = createAudioPlayer({ uri }, { crossOrigin: 'anonymous' });
  const release = (): void => {
    try {
      player.remove();
    } catch {
      // Already removed.
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = (settleWith: () => void): void => {
        signal.removeEventListener('abort', onAbort);
        settleWith();
      };

      if (onLevel !== undefined) {
        player.setAudioSamplingEnabled(true);
        const meter = createAudioLevelMeter();
        player.addListener('audioSampleUpdate', (sample) => {
          const frames = sample.channels[0]?.frames;
          if (frames === undefined) return;
          onLevel(meter.push(frames, Date.now()));
        });
      }
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.error) {
          settle(() => reject(new Error(String(status.error))));
          return;
        }
        if (status.didJustFinish) settle(resolve);
      });
      player.play();
    });
  } finally {
    release();
    onLevel?.(0);
  }
}
