// @alia.onl/sdk/voice — Alia voice surface
// The voice call (speech to speech through Alia's /v1/voice/session and Kaana),
// its audio engine, audio visualisation, ambient wave and sound effects. Split
// out of the root entry so text-chat consumers never compile the call or
// `react-native-audio-api`.

// ── Voice components ──
export { VoiceSession } from './components/voice/VoiceSession';
export { VoiceControls } from './components/voice/VoiceControls';
export { VOICE_CONTROLS_LABELS } from './components/voice/VoiceControls';
export type { VoiceControlsLabels, VoiceControlsProps } from './components/voice/VoiceControls';

// ── Voice hooks ──
export { useVoiceRoom, roomStateOf, agentStateOf } from './hooks/useVoiceRoom';
export type { UseVoiceRoomOptions } from './hooks/useVoiceRoom';
export { VoiceCall } from './lib/voice-call';
export type {
  VoiceCallOptions,
  VoiceCallSnapshot,
  VoiceSocket,
  VoiceSocketFactory,
} from './lib/voice-call';
export { createVoiceAudioEngine, VoiceAudioEngineError } from './lib/voice-audio-engine';
export type {
  VoiceAudioEngine,
  VoiceAudioEngineErrorCode,
  VoiceAudioEngineHandlers,
} from './lib/voice-audio-engine-types';
export {
  VOICE_PROTOCOL_VERSION,
  VOICE_SAMPLE_RATE,
  decodeAssistantAudioFrame,
  encodeAssistantAudioFrame,
  voiceSessionUrl,
} from './lib/voice-protocol';
export type {
  VoiceClientEvent,
  VoiceCloseReason,
  VoiceServerErrorCode,
  VoiceServerEvent,
} from './lib/voice-protocol';
export type { VoiceLevelSource } from './lib/voice-levels';
export { VOICE_ERROR_MESSAGES } from './lib/speech-messages';
export type { VoiceErrorCode } from './lib/speech-messages';
export { useAudioLevelMonitor } from './hooks/useAudioLevelMonitor';
export { useAudioLevels } from './hooks/useAudioLevels';
export { useAmbientWave } from './hooks/useAmbientWave';
export type {
  UseAmbientWaveOptions,
  UseAmbientWaveResult,
  AmbientWaveVoice,
  AmbientWaveMode,
} from './hooks/useAmbientWave';
export { useSoundEffects, useVoiceSoundEffects } from './hooks/useSoundEffects';
export type { SoundName, SoundSources } from './hooks/useSoundEffects';

// ── Voice types ──
export type {
  RoomState,
  AgentState,
  VoiceCallState,
  VoiceMessage,
  VoiceToolInvocation,
  VoiceSessionProps,
  VoiceSessionState,
} from './types';
