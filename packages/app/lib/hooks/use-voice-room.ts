/**
 * App-specific wrapper around the SDK's useVoiceRoom hook.
 *
 * Injects the app's API URL from config and the user's voice preference
 * from the user data store, then re-exports the types for convenience.
 */

import { useVoiceRoom as useVoiceRoomSDK } from '@alia.onl/sdk/voice';
import config from '../config';
import { useUserDataStore } from '../stores/user-data-store';

export type { RoomState, AgentState, VoiceMessage, VoiceToolInvocation } from '@alia.onl/sdk/voice';

export function useVoiceRoom() {
  const voicePref = useUserDataStore(s => s.memory?.preferences?.voice);

  return useVoiceRoomSDK({
    apiUrl: config.apiUrl,
    voicePreference: voicePref === 'male' ? 'male' : 'female',
  });
}
