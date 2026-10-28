/**
 * Alia's streaming dictation protocol, `GET /v1/audio/transcriptions/stream`
 * (ADR 0024).
 *
 * The SDK's copy is `packages/alia-chat/src/lib/dictation-protocol.ts`; the SDK
 * does not depend on the API package, so the shapes are restated there and
 * `DICTATION_PROTOCOL_VERSION` turns a mismatch into a refusal instead of a
 * misunderstanding.
 *
 * - Binary, client → Alia: microphone PCM16 LE, 24 kHz, mono.
 * - Text: one JSON event per frame, both ways.
 *
 * Segments are Alia's numbers, from 0, in the order the person spoke them: the
 * device never sees Kaana's item ids. A segment's `transcript.final` is the only
 * text a client keeps; `transcript.interim` and `transcript.delta` are display
 * state that the final supersedes.
 */

import { z } from 'zod';
import type { TranscriptionErrorCode } from '../voice/transcribe.js';

export const DICTATION_PROTOCOL_VERSION = 1;

export const DICTATION_STREAM_PATH = '/v1/audio/transcriptions/stream';

/** PCM16 mono at this rate: the one encoding the stream takes. */
export const DICTATION_SAMPLE_RATE = 24_000;

/** Decoded bytes of one second of {@link DICTATION_SAMPLE_RATE} PCM16 mono. */
export const DICTATION_BYTES_PER_SECOND = DICTATION_SAMPLE_RATE * 2;

/** What a dictation ends with that is not a failure. */
export type DictationCloseReason =
  | 'ended'
  | 'max-duration'
  | 'idle-timeout'
  | 'error'
  | 'server-shutdown';

/** The failures a dictation reports: the batch route's codes, plus who may call. */
export type DictationStreamErrorCode =
  | TranscriptionErrorCode
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

const languageSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
  .max(35);

const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(8_192) }).strict(),
  z
    .object({
      type: z.literal('dictation.start'),
      protocol: z.number().int(),
      language: languageSchema.optional(),
      sampleRate: z.literal(DICTATION_SAMPLE_RATE),
    })
    .strict(),
  z.object({ type: z.literal('dictation.commit') }).strict(),
  z.object({ type: z.literal('dictation.end') }).strict(),
]);

export type DictationClientEvent = z.infer<typeof clientEventSchema>;

/** One client text frame, or `null` when it is not one of protocol 1's events. */
export function parseDictationClientEvent(text: string): DictationClientEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = clientEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
