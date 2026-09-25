/**
 * App-specific wrapper around the SDK's useVoiceRoom hook.
 *
 * Injects the app's API URL, the user's voice preference and the app's
 * language, then re-exports the types for convenience. `sendTurn` is how the
 * conversation screen makes a call's turns its own turns — see
 * `use-voice-mode.ts`.
 */

import { useVoiceRoom as useVoiceRoomSDK, type VoiceTurnSender } from '@alia.onl/sdk/voice';
import config from '@/shared/platform/config';
import { speechLocale } from '@/features/voice/model/speech-locale';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';

export type { RoomState, AgentState, VoiceMessage, VoiceToolInvocation } from '@alia.onl/sdk/voice';

export function useVoiceRoom(sendTurn: VoiceTurnSender) {
  const voicePref = useUserDataStore(s => s.memory?.preferences?.voice);

  return useVoiceRoomSDK({
    apiUrl: config.apiUrl,
    voicePreference: voicePref === 'male' ? 'male' : 'female',
    lang: speechLocale(),
    sendTurn,
  });
}
