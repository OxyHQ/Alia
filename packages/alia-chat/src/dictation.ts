// @alia.onl/sdk/dictation — dictation's network half, without a component, a hook or a recorder
// `POST /v1/audio/transcriptions` (ADR 0017 §7) and the streaming dictation socket
// `GET /v1/audio/transcriptions/stream` (ADR 0024) as plain functions: an app that records audio
// its own way (Astro's browser shell) dictates from here and reaches no React, no native module
// and no Oxy client. `useDictation` and `AliaComposer` use the same batch request.

export {
  DictationError,
  dictationFailureCode,
  MAX_DICTATION_MS,
  normalizeAudioMediaType,
  requestTranscription,
} from './lib/dictation';
export type {
  DictationClip,
  DictationErrorCode,
  TranscriptionRequest,
  TranscriptionResult,
} from './lib/dictation';
export type { AudioRequestAuthentication } from './lib/audio-request-auth';
export type { VoiceErrorCode } from './lib/speech-messages';
export {
  DICTATION_PROTOCOL_VERSION,
  DICTATION_SAMPLE_RATE,
  DICTATION_STREAM_PATH,
  dictationStreamUrl,
  parseDictationServerEvent,
} from './lib/dictation-protocol';
export type {
  DictationCloseReason,
  DictationServerEvent,
  DictationStreamErrorCode,
} from './lib/dictation-protocol';
export { openDictationStream } from './lib/dictation-stream';
export type {
  DictationSocket,
  DictationStream,
  DictationStreamAuthentication,
  DictationStreamOptions,
} from './lib/dictation-stream';
