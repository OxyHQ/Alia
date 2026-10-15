/**
 * App-specific wrapper around the SDK's `useVoiceRoom`: the app's API, the
 * person's voice preference and the app's language, for one conversation (and
 * its agent). The call itself is a realtime session through Alia
 * (`/v1/voice/session`, ADR 0017).
 */

import { useVoiceRoom as useVoiceRoomSDK } from '@alia.onl/sdk/voice';
import config from '@/shared/platform/config';
import { speechLocale } from '@/features/voice/model/speech-locale';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';

export type {
  RoomState,
  AgentState,
  VoiceMessage,
  VoiceToolInvocation,
  VoiceCallState,
} from '@alia.onl/sdk/voice';

export interface UseAppVoiceRoomOptions {
  conversationId: string;
  agentId?: string;
  /** Alia stored messages of the call in the conversation. */
  onMessagesSaved?: (conversationId: string, messageIds: readonly string[]) => void;
}

export function useVoiceRoom({ conversationId, agentId, onMessagesSaved }: UseAppVoiceRoomOptions) {
  const voicePref = useUserDataStore((s) => s.memory?.preferences?.voice);

  return useVoiceRoomSDK({
    apiUrl: config.apiUrl,
    conversationId,
    ...(agentId === undefined ? {} : { agentId }),
    voicePreference: voicePref === 'male' ? 'male' : 'female',
    lang: speechLocale(),
    ...(onMessagesSaved === undefined ? {} : { onMessagesSaved }),
  });
}
