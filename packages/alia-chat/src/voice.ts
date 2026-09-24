// @alia.onl/sdk/voice — Alia voice surface
// The on-device voice loop (listen → chat → speak), audio visualisation,
// ambient wave, and sound effects. Split out of the root entry so text-chat
// consumers never compile the call.

// ── Voice components ──
export { VoiceSession } from './components/voice/VoiceSession';
export { AudioWaveVisualizer } from './components/voice/AudioWaveVisualizer';
export { VoiceOverlay } from './components/voice/VoiceOverlay';
export { VoiceControls } from './components/voice/VoiceControls';

// ── Voice hooks ──
export { useVoiceRoom } from './hooks/useVoiceRoom';
export type { UseVoiceRoomOptions } from './hooks/useVoiceRoom';
export { createAliaVoiceTurnSender } from './lib/voice-turn';
export type { VoiceTurn, VoiceTurnMessage, VoiceTurnSender, AliaVoiceTurnSenderOptions } from './lib/voice-turn';
export type { VoiceLevelSource } from './lib/voice-levels';
export { useAudioLevelMonitor } from './hooks/useAudioLevelMonitor';
export { useAudioLevels } from './hooks/useAudioLevels';
export { useAmbientWave } from './hooks/useAmbientWave';
export type { UseAmbientWaveOptions, UseAmbientWaveResult, AmbientWaveVoice, AmbientWaveMode } from './hooks/useAmbientWave';
export { useSoundEffects, useVoiceSoundEffects } from './hooks/useSoundEffects';
export type { SoundName, SoundSources } from './hooks/useSoundEffects';

// ── Voice types ──
export type {
  RoomState,
  AgentState,
  VoiceMessage,
  VoiceToolInvocation,
  VoiceSessionProps,
  VoiceSessionState,
} from './types';
