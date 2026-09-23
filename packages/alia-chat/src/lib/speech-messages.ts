import type { SpeechRecognitionFailure } from './speech-recognition-types';

/**
 * The copy a person sees when listening fails — the same sentences dictation
 * and voice mode used when they recorded through `expo-audio` and LiveKit, so
 * moving recognition onto the device did not change what an error says.
 *
 * `null` for the failures that are not errors: `aborted` is a stop the caller
 * asked for, and `no-speech` is a silence the caller recovers from.
 */
export function speechFailureMessage(failure: SpeechRecognitionFailure): string | null {
  switch (failure.code) {
    case 'aborted':
    case 'no-speech':
      return null;
    case 'unsupported':
      return 'Speech recognition is not available on this device or browser';
    case 'not-allowed':
      return 'Microphone permission required';
    case 'audio-capture':
      return failure.detail === 'NotReadableError' || failure.detail === 'TrackStartError'
        ? 'Microphone is in use by another application'
        : 'No microphone found — check your input devices';
    case 'network':
      return 'Speech recognition needs a network connection';
    case 'language-not-supported':
      return 'Speech recognition does not support this language';
    case 'other':
      return 'Speech recognition failed';
  }
}
