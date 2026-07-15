/// <reference path="./optional-deps.d.ts" />
// @alia.onl/sdk/voice — Alia voice surface
// LiveKit-backed voice room, audio visualisation, ambient wave, and sound effects.
// Split out of the root entry so text-chat consumers never pull livekit-client
// into their module graph.

// ── Voice components ──
export { AudioWaveVisualizer } from './components/voice/AudioWaveVisualizer';
export { VoiceOverlay } from './components/voice/VoiceOverlay';
export { VoiceControls } from './components/voice/VoiceControls';

// ── Voice hooks ──
export { useVoiceRoom } from './hooks/useVoiceRoom';
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
} from './types';
