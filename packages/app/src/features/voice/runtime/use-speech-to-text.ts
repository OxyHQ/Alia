/**
 * App-specific wrapper around the SDK's useSpeechToText hook.
 *
 * Dictation is recognized on the device, in the app's language — see
 * `src/features/voice/model/speech-locale.ts`. Nothing is sent to the API.
 */

import { useSpeechToText as useSpeechToTextSDK } from '@alia.onl/sdk';
import { speechLocale } from '@/features/voice/model/speech-locale';

export function useSpeechToText() {
  return useSpeechToTextSDK({ lang: speechLocale() });
}
