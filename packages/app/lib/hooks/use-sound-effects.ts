/**
 * App-specific wrapper around the SDK's voice sound effects hook.
 *
 * The SDK accepts sound sources via options (no hardcoded require() calls), so
 * we pass in the app's bundled sound assets here.
 */

import {
  useVoiceSoundEffects as useVoiceSoundEffectsSDK,
  type SoundSources,
  type AgentState,
} from '@alia.onl/sdk/voice';

// Static require() calls — Metro needs these to be static literals
const APP_SOUNDS: SoundSources = {
  thinking: require('@/assets/sounds/thinking.mp3'),
  toolCall: require('@/assets/sounds/tool-call.mp3'),
  voiceConnect: require('@/assets/sounds/voice-connect.mp3'),
  voiceDisconnect: require('@/assets/sounds/voice-disconnect.mp3'),
};

export function useVoiceSoundEffects({
  isVoiceActive,
  agentState,
  isConnected,
}: {
  isVoiceActive: boolean;
  agentState: AgentState;
  isConnected: boolean;
}) {
  return useVoiceSoundEffectsSDK({
    isVoiceActive,
    agentState,
    isConnected,
    sounds: APP_SOUNDS,
  });
}
