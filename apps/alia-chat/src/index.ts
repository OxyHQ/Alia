/// <reference path="./optional-deps.d.ts" />
// @alia.onl/sdk — Alia AI Chat SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main components ──
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';
export { AliaChatScreen } from './components/AliaChatScreen';
export type { AliaChatScreenProps } from './components/AliaChatScreen';

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
export { useSpeechToText, useSTTStore } from './hooks/useSpeechToText';
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

// ── UI Primitives (NativeWind) ──
export { Button, buttonVariants, buttonTextVariants } from './components/ui/button';
export type { ButtonProps } from './components/ui/button';
export { Text, TextClassContext } from './components/ui/text';
export { ChatTextInput } from './components/ui/chat-text-input';
export { cn, formatFileSize } from './lib/utils';

// ── PromptInput ──
export { PromptInput } from './components/ui/prompt-input/prompt-input';
export type { PromptInputProps } from './components/ui/prompt-input/prompt-input';
export { usePromptInput, useIsFullscreen, PromptInputContext } from './components/ui/prompt-input/context';
export type { Attachment, Completion, PromptInputContextType } from './components/ui/prompt-input/context';
export { PromptInputTextarea } from './components/ui/prompt-input/textarea';
export { PromptInputActions } from './components/ui/prompt-input/actions';
export { PromptInputSubmitButton } from './components/ui/prompt-input/submit-button';
export { PromptInputMicButton } from './components/ui/prompt-input/mic-button';
export { PromptInputAddMenu } from './components/ui/prompt-input/add-menu';
export { PromptInputAttachments } from './components/ui/prompt-input/attachments';
export { PromptInputAutocomplete } from './components/ui/prompt-input/autocomplete';

// ── Picker hooks ──
export { useImagePicker } from './hooks/useImagePicker';
export type { ImagePickerAsset } from './hooks/useImagePicker';
export { useDocumentPicker } from './hooks/useDocumentPicker';
export type { DocumentPickerResult } from './hooks/useDocumentPicker';

// ── Keyboard ──
export { KeyboardAwareScrollView, KeyboardAvoidingView, KeyboardProvider } from './lib/keyboard';

// ── Theme ──
export { useAliaColors } from './theme';
export type { AliaColors } from './theme';
