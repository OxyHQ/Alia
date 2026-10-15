/**
 * Dictation's network half: a recorded clip to `POST /v1/audio/transcriptions`
 * (ADR 0017 §7), which Alia answers with a Kaana transcription model computed
 * from the catalogue. Free on every plan; at most five minutes per clip.
 *
 * Batch, not streaming: the text arrives once the person stops. Nothing is
 * recognized on the device.
 */

import type { VoiceErrorCode } from './speech-messages';

/** The longest clip one dictation may be. */
export const MAX_DICTATION_MS = 5 * 60_000;

/** A clip as a recorder hands it over: a web `Blob`, or a React Native file. */
export interface DictationClip {
  readonly file: Blob | { readonly uri: string; readonly name: string; readonly type: string };
  /** Without parameters: `audio/webm`, `audio/mp4`, … */
  readonly mediaType: string;
  /** Measured by the recorder. */
  readonly durationMs: number;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  /** The model that transcribed it (its name may be shown). */
  readonly model?: string;
}

/** What the route answers a failure with, plus the two this side knows on its own. */
export type DictationErrorCode =
  | 'TRANSCRIPTION_UNAVAILABLE'
  | 'TRANSCRIPTION_LIMITED'
  | 'TRANSCRIPTION_REJECTED'
  | 'TRANSCRIPTION_FAILED'
  | 'CLIP_TOO_LONG'
  | 'INVALID_REQUEST'
  | 'NOT_AUTHENTICATED'
  | 'CREDENTIAL_NOT_SUPPORTED';

const SERVER_CODES: ReadonlySet<string> = new Set<DictationErrorCode>([
  'TRANSCRIPTION_UNAVAILABLE',
  'TRANSCRIPTION_LIMITED',
  'TRANSCRIPTION_REJECTED',
  'TRANSCRIPTION_FAILED',
  'CLIP_TOO_LONG',
  'INVALID_REQUEST',
  'NOT_AUTHENTICATED',
  'CREDENTIAL_NOT_SUPPORTED',
]);

export class DictationError extends Error {
  /** `null` when no request was answered (network) or the code is unknown. */
  readonly code: DictationErrorCode | null;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { code: DictationErrorCode | null; status: number | null; retryable?: boolean },
  ) {
    super(message);
    this.name = 'DictationError';
    this.code = details.code;
    this.status = details.status;
    this.retryable = details.retryable ?? false;
  }
}

/** The `VoiceErrorCode` an app says a failed transcription with. */
export function dictationFailureCode(error: unknown): VoiceErrorCode {
  if (!(error instanceof DictationError)) return 'transcription-failed';
  switch (error.code) {
    case 'TRANSCRIPTION_UNAVAILABLE':
      return 'transcription-unavailable';
    case 'TRANSCRIPTION_LIMITED':
      return 'transcription-limited';
    case 'TRANSCRIPTION_REJECTED':
    case 'INVALID_REQUEST':
      return 'transcription-rejected';
    case 'CLIP_TOO_LONG':
      return 'too-long';
    case 'NOT_AUTHENTICATED':
      return 'not-authenticated';
    case 'CREDENTIAL_NOT_SUPPORTED':
      return 'credential-not-supported';
    case 'TRANSCRIPTION_FAILED':
    case null:
      return 'transcription-failed';
  }
}

/** `audio/webm;codecs=opus` → `audio/webm`; iOS's m4a names → `audio/mp4`. */
export function normalizeAudioMediaType(type: string): string {
  const bare = type.split(';')[0]!.trim().toLowerCase();
  if (bare === 'audio/x-m4a' || bare === 'audio/m4a' || bare === 'audio/aac-mp4')
    return 'audio/mp4';
  return bare;
}

function fileNameFor(mediaType: string): string {
  switch (mediaType) {
    case 'audio/webm':
      return 'dictation.webm';
    case 'audio/ogg':
      return 'dictation.ogg';
    case 'audio/mpeg':
      return 'dictation.mp3';
    case 'audio/wav':
      return 'dictation.wav';
    default:
      return 'dictation.m4a';
  }
}

export interface TranscriptionRequest {
  readonly apiUrl: string;
  readonly token: string;
  readonly clip: DictationClip;
  /** BCP-47. */
  readonly language: string;
  readonly signal?: AbortSignal;
}

/**
 * Transcribe one clip.
 *
 * @throws {DictationError} for every refusal; an abort is thrown as `fetch` threw it.
 */
export async function requestTranscription(
  request: TranscriptionRequest,
): Promise<TranscriptionResult> {
  if (request.token === '')
    throw new DictationError('Not authenticated', { code: 'NOT_AUTHENTICATED', status: null });
  const mediaType = normalizeAudioMediaType(request.clip.mediaType);
  const form = new FormData();
  const { file } = request.clip;
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    form.append('file', file, fileNameFor(mediaType));
  } else {
    // React Native's FormData takes a file by `{ uri, name, type }`.
    form.append('file', file as unknown as Blob);
  }
  form.append('language', request.language);
  form.append('durationMs', String(Math.max(0, Math.round(request.clip.durationMs))));

  let response: Response;
  try {
    response = await fetch(`${request.apiUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.token}` },
      body: form,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (caught: unknown) {
    if ((caught as { name?: unknown } | null)?.name === 'AbortError') throw caught;
    throw new DictationError('The transcription request did not reach Alia', {
      code: null,
      status: null,
      retryable: true,
    });
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope =
      body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    const error =
      envelope !== null && typeof envelope === 'object'
        ? (envelope as { code?: unknown; message?: unknown; retryable?: unknown })
        : {};
    const named =
      typeof error.code === 'string' && SERVER_CODES.has(error.code)
        ? (error.code as DictationErrorCode)
        : null;
    throw new DictationError(
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : 'Transcription failed',
      {
        code:
          named ??
          (response.status === 401
            ? 'NOT_AUTHENTICATED'
            : response.status === 413
              ? 'CLIP_TOO_LONG'
              : null),
        status: response.status,
        retryable: error.retryable === true,
      },
    );
  }
  const result = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof result.text !== 'string') {
    throw new DictationError('Alia answered no transcription', {
      code: 'TRANSCRIPTION_FAILED',
      status: response.status,
    });
  }
  return {
    text: result.text,
    ...(typeof result.language === 'string' ? { language: result.language } : {}),
    ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
    ...(typeof result.model === 'string' ? { model: result.model } : {}),
  };
}
