/// <reference path="./optional-deps.d.ts" />
// @alia.onl/sdk — Alia AI Chat SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main component ──
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';

// ── Chat UI components ──
export { AliaFace } from './components/AliaFace';
export type { AliaExpression, AliaFaceProps } from './components/AliaFace';
export { ThinkingIndicator } from './components/ThinkingIndicator';
export { AliaMarkdown } from './components/Markdown';
export { Reasoning, ReasoningTrigger, ReasoningContent } from './components/Reasoning';

// ── Voice components ──
export { AudioWaveVisualizer } from './components/voice/AudioWaveVisualizer';
export { VoiceOverlay } from './components/voice/VoiceOverlay';
export { VoiceControls } from './components/voice/VoiceControls';

// ── Chat hook ──
export { useAliaChat } from './hooks/useAliaChat';
export type { UseAliaChatOptions, UseAliaChatReturn } from './hooks/useAliaChat';

// ── Voice hooks ──
export { useVoiceRoom } from './hooks/useVoiceRoom';
export { useAudioLevelMonitor } from './hooks/useAudioLevelMonitor';
export { useAudioLevels } from './hooks/useAudioLevels';
export { useTTS } from './hooks/useTTS';
export type { UseTTSOptions } from './hooks/useTTS';
export { useSpeechToText } from './hooks/useSpeechToText';
export type { UseSTTOptions } from './hooks/useSpeechToText';
export { useSoundEffects, useVoiceSoundEffects } from './hooks/useSoundEffects';
export type { SoundName, SoundSources } from './hooks/useSoundEffects';

// ── Types ──
export type {
  ChatMessage,
  ToolInvocation,
  AliaChatSuggestion,
  ResearchProgress,
  PendingPlan,
  RoomState,
  AgentState,
  VoiceMessage,
  VoiceToolInvocation,
} from './types';

// ── Theme ──
export { useAliaColors } from './theme';
export type { AliaColors } from './theme';
