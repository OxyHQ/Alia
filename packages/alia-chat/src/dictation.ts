// @alia.onl/sdk/dictation — dictation's request, without a component, a hook or a recorder
// `POST /v1/audio/transcriptions` (ADR 0017 §7) as plain functions: an app that records audio its
// own way (Astro's browser shell) sends its clips from here and reaches no React, no native module
// and no Oxy client. `useDictation` and `AliaComposer` use the same request.

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
