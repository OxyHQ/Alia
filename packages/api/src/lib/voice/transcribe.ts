/**
 * Dictation: one recorded clip, transcribed by Kaana (ADR 0017 §7).
 *
 * The composer's microphone records, uploads the clip on stop, and the text
 * goes into the draft. Batch, not a streaming session: no Kaana adapter serves
 * live transcription, and batch costs a fraction. The model is computed from
 * the catalogue (`rankTranscriptionCandidates`), never named. At most three
 * attempts, and only when the model itself refused, as speech does.
 *
 * Free on every plan: no plan feature, no credits; the cost is Alia's internal
 * cost centre (ADR 0005). The 5-minute clip and the `/v1` per-user rate limit
 * bound it.
 */

import { TTLCache } from '../ttl-cache.js';
import {
  type AudioInputMediaType,
  MAX_TRANSCRIPTION_FILE_BYTES,
  type Model,
} from '@kaana.ai/contracts';
import { KaanaError } from '@kaana.ai/sdk';
import type { KaanaClient } from '../kaana/port.js';
import { log } from '../logger.js';
import { rankTranscriptionCandidates } from '../models/voice-models.js';
import { isModelRefusal } from './errors.js';

/** The longest clip one dictation may be. */
export const MAX_DICTATION_MS = 5 * 60_000;
/** A recorder's own measurement may run a little over the cap it stopped at. */
const DURATION_SLACK_MS = 2_000;
const MAX_ATTEMPTS = 3;

export type TranscriptionErrorCode =
  | 'TRANSCRIPTION_UNAVAILABLE'
  | 'TRANSCRIPTION_LIMITED'
  | 'TRANSCRIPTION_REJECTED'
  | 'TRANSCRIPTION_FAILED'
  | 'CLIP_TOO_LONG'
  | 'INVALID_REQUEST';

const STATUS: Readonly<Record<TranscriptionErrorCode, number>> = {
  TRANSCRIPTION_UNAVAILABLE: 503,
  TRANSCRIPTION_LIMITED: 429,
  TRANSCRIPTION_REJECTED: 422,
  TRANSCRIPTION_FAILED: 502,
  CLIP_TOO_LONG: 413,
  INVALID_REQUEST: 400,
};

/** Fixed, provider-neutral product text per code. */
const MESSAGE: Readonly<Record<TranscriptionErrorCode, string>> = {
  TRANSCRIPTION_UNAVAILABLE: 'Dictation is not available right now.',
  TRANSCRIPTION_LIMITED: 'Dictation has reached its limit for now. Try again later.',
  TRANSCRIPTION_REJECTED: 'This recording could not be transcribed.',
  TRANSCRIPTION_FAILED: 'Transcription failed. Try again.',
  CLIP_TOO_LONG: 'A dictation can be at most 5 minutes long.',
  INVALID_REQUEST: 'The recording is missing or in a format that is not accepted.',
};

export class TranscriptionError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(
    readonly code: TranscriptionErrorCode,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(MESSAGE[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranscriptionError';
    this.httpStatus = STATUS[code];
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

const MEDIA_TYPES: ReadonlyMap<string, AudioInputMediaType> = new Map<string, AudioInputMediaType>([
  ['audio/webm', 'audio/webm'],
  ['video/webm', 'audio/webm'],
  ['audio/mp4', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4'],
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/aac', 'audio/aac'],
  ['audio/ogg', 'audio/ogg'],
  ['audio/mpeg', 'audio/mpeg'],
  ['audio/mp3', 'audio/mpeg'],
  ['audio/wav', 'audio/wav'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/flac', 'audio/flac'],
]);

/** The contract's media type for an upload's `Content-Type`, codecs dropped; `null` when not accepted. */
export function dictationMediaType(contentType: string | undefined): AudioInputMediaType | null {
  if (!contentType) return null;
  const bare = contentType.split(';')[0]!.trim().toLowerCase();
  return MEDIA_TYPES.get(bare) ?? null;
}

function failureOf(error: unknown): TranscriptionError {
  if (!(error instanceof KaanaError))
    return new TranscriptionError('TRANSCRIPTION_FAILED', { retryable: true, cause: error });
  const kaana = error;
  switch (kaana.code) {
    case 'rate_limited':
    case 'insufficient_balance':
    case 'spending_limit_exceeded':
    case 'quota_exceeded':
      return new TranscriptionError('TRANSCRIPTION_LIMITED', {
        retryable: kaana.retryable,
        ...(kaana.retryAfterMs === undefined ? {} : { retryAfterMs: kaana.retryAfterMs }),
        cause: error,
      });
    case 'no_route_available':
    case 'service_unavailable':
    case 'model_not_found':
    case 'authentication_failed':
      return new TranscriptionError('TRANSCRIPTION_UNAVAILABLE', {
        retryable: kaana.retryable,
        cause: error,
      });
    case 'provider_error':
    case 'provider_timeout':
    case 'provider_overloaded':
    case 'internal_error':
    case 'cancelled':
      return new TranscriptionError('TRANSCRIPTION_FAILED', {
        retryable: kaana.retryable,
        cause: error,
      });
    case 'request_too_large':
      return new TranscriptionError('CLIP_TOO_LONG', { cause: error });
    default:
      return new TranscriptionError('TRANSCRIPTION_REJECTED', { cause: error });
  }
}

function upstreamCodeOf(error: unknown): string | null {
  return error instanceof KaanaError ? error.code : null;
}

const catalogueCache = new TTLCache<Model[]>({ ttlMs: 60_000, maxSize: 4 });

/** Test seam. */
export function resetTranscriptionCatalogueForTests(): void {
  catalogueCache.delete('models');
}

export interface DictationClip {
  readonly audio: Uint8Array;
  readonly mediaType: AudioInputMediaType;
  /** The recorder's own measurement of the clip, in ms. */
  readonly durationMs: number;
  /** BCP 47, the app's language; omitted lets the model detect it. */
  readonly language?: string;
}

/** The clip's text and the model that served it. Never partial, never invented. */
export async function transcribeDictation(
  kaana: KaanaClient | null,
  oxyUserId: string,
  clip: DictationClip,
): Promise<{ text: string; model: string; language?: string; durationMs?: number }> {
  if (clip.durationMs > MAX_DICTATION_MS + DURATION_SLACK_MS)
    throw new TranscriptionError('CLIP_TOO_LONG');
  if (clip.audio.byteLength === 0) throw new TranscriptionError('INVALID_REQUEST');
  if (clip.audio.byteLength > MAX_TRANSCRIPTION_FILE_BYTES)
    throw new TranscriptionError('CLIP_TOO_LONG');
  if (!kaana) throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE');

  let models = catalogueCache.get('models');
  if (!models) {
    models = await kaana.models.list({ onBehalfOfUserId: oxyUserId }).catch((error: unknown) => {
      throw failureOf(error);
    });
    catalogueCache.set('models', models);
  }
  const candidates = rankTranscriptionCandidates(models, { mediaType: clip.mediaType }).slice(
    0,
    MAX_ATTEMPTS,
  );
  if (candidates.length === 0) throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE');

  for (const [index, candidate] of candidates.entries()) {
    try {
      const result = await kaana.audio.transcriptions.create(
        {
          model: candidate.model.modelId,
          file: clip.audio,
          mediaType: clip.mediaType,
          // The person's BCP 47 tag as it is: Kaana gives every model the language.
          ...(clip.language === undefined ? {} : { language: clip.language }),
        },
        { onBehalfOfUserId: oxyUserId },
      );
      return {
        text: result.text.trim(),
        model: result.model,
        ...(result.language === undefined ? {} : { language: result.language }),
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
      };
    } catch (error) {
      const failure = failureOf(error);
      log.voice.warn(
        {
          code: failure.code,
          upstreamCode: upstreamCodeOf(error),
          model: candidate.model.modelId,
          bytes: clip.audio.byteLength,
          durationMs: clip.durationMs,
        },
        'Dictation transcription failed',
      );
      if (index < candidates.length - 1 && isModelRefusal(error)) continue;
      throw failure;
    }
  }
  throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE');
}
