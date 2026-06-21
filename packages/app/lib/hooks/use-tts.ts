/**
 * App-specific wrapper around the SDK's useTTS hook.
 *
 * Injects the app's API URL, voice preference, and tone preference
 * from the user data store so callers don't need to pass config.
 */

import { useTTS as useTTSSDK } from '@alia.onl/sdk';
import config from '@/lib/config';
import { useUserDataStore } from '@/lib/stores/user-data-store';

export function useTTS() {
  const voicePref = useUserDataStore(s => s.memory?.preferences?.voice);
  const tonePref = useUserDataStore(s => s.memory?.preferences?.tone);

  return useTTSSDK({
    apiUrl: config.apiUrl,
    voice: voicePref === 'male' ? 'male' : 'female',
    tone: tonePref === 'brief' ? 'brief' : tonePref === 'chill' ? 'chill' : 'default',
  });
}
