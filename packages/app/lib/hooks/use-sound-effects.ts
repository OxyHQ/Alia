/**
 * App-specific wrappers around the SDK's sound effects hooks.
 *
 * The SDK's useSoundEffects accepts sound sources via options (no hardcoded
 * require() calls), so we pass in the app's bundled sound assets here.
 */

import {
  useSoundEffects as useSoundEffectsSDK,
  useVoiceSoundEffects as useVoiceSoundEffectsSDK,
  type SoundSources,
} from '@alia.onl/sdk';
import type { AgentState } from '@alia.onl/sdk';

// Static require() calls — Metro needs these to be static literals
const APP_SOUNDS: SoundSources = {
  thinking: require('@/assets/sounds/thinking.mp3'),
  toolCall: require('@/assets/sounds/tool-call.mp3'),
  voiceConnect: require('@/assets/sounds/voice-connect.mp3'),
  voiceDisconnect: require('@/assets/sounds/voice-disconnect.mp3'),
};

export function useSoundEffects(enabled: boolean = false) {
  return useSoundEffectsSDK(enabled, APP_SOUNDS);
}

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
