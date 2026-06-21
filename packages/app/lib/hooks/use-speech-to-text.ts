/**
 * App-specific wrapper around the SDK's useSpeechToText hook.
 *
 * Injects the app's API URL from config.
 */

import { useSpeechToText as useSpeechToTextSDK } from '@alia.onl/sdk';
import config from '../config';

export function useSpeechToText() {
  return useSpeechToTextSDK({
    apiUrl: config.apiUrl,
  });
}
