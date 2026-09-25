import type { SpeechRecognitionFailure } from './speech-recognition-types';

/**
 * Every way dictation or a voice call can fail that a person is told about,
 * as a stable code.
 *
 * The hooks expose the code beside the English sentence (`errorCode` /
 * `turnErrorCode` next to `error` / `turnError`) so an app can say it in its
 * own language; the sentence stays for a consumer that has no translations.
 */
export type VoiceErrorCode =
  | 'speech-unsupported'
  | 'microphone-denied'
  | 'microphone-busy'
  | 'microphone-missing'
  | 'speech-network'
  | 'speech-language'
  | 'speech-failed'
  | 'voice-unavailable'
  | 'not-authenticated'
  | 'turn-failed'
  | 'no-answer'
  | 'not-played';

/**
 * The English copy for each code — the same sentences dictation and voice mode
 * used when they recorded through `expo-audio` and LiveKit, so moving
 * recognition onto the device did not change what an error says.
 */
export const VOICE_ERROR_MESSAGES: Readonly<Record<VoiceErrorCode, string>> = {
  'speech-unsupported': 'Speech recognition is not available on this device or browser',
  'microphone-denied': 'Microphone permission required',
  'microphone-busy': 'Microphone is in use by another application',
  'microphone-missing': 'No microphone found — check your input devices',
  'speech-network': 'Speech recognition needs a network connection',
  'speech-language': 'Speech recognition does not support this language',
  'speech-failed': 'Speech recognition failed',
  'voice-unavailable': 'Voice is not available on this device',
  'not-authenticated': 'Not authenticated',
  'turn-failed': 'Voice request failed',
  'no-answer': 'No answer came back — try saying it again',
  'not-played': 'The answer could not be played aloud',
};

/**
 * The code for a recognition failure. `null` for the failures that are not
 * errors: `aborted` is a stop the caller asked for, and `no-speech` is a
 * silence the caller recovers from.
 */
export function speechFailureCode(failure: SpeechRecognitionFailure): VoiceErrorCode | null {
  switch (failure.code) {
    case 'aborted':
    case 'no-speech':
      return null;
    case 'unsupported':
      return 'speech-unsupported';
    case 'not-allowed':
      return 'microphone-denied';
    case 'audio-capture':
      return failure.detail === 'NotReadableError' || failure.detail === 'TrackStartError'
        ? 'microphone-busy'
        : 'microphone-missing';
    case 'network':
      return 'speech-network';
    case 'language-not-supported':
      return 'speech-language';
    case 'other':
      return 'speech-failed';
  }
}

/** The English copy a person sees when listening fails; `null` as for `speechFailureCode`. */
export function speechFailureMessage(failure: SpeechRecognitionFailure): string | null {
  const code = speechFailureCode(failure);
  return code === null ? null : VOICE_ERROR_MESSAGES[code];
}
