/// <reference types="nativewind/types" />
// @alia.onl/sdk — Alia AI Chat SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main components ──
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';
export { AliaChatScreen } from './components/AliaChatScreen';
export type { AliaChatScreenProps } from './components/AliaChatScreen';

// ── Chat UI components ──
export { IdentityMark } from './components/IdentityMark';
export type { IdentityMarkProps, IdentityMarkState } from './components/IdentityMark';
export { ThinkingIndicator } from './components/ThinkingIndicator';
export { AliaMarkdown } from './components/Markdown';
export type { AliaMarkdownProps } from './components/Markdown';
export { Reasoning, ReasoningTrigger, ReasoningContent } from './components/Reasoning';
export { AliaWelcomeMessage } from './components/AliaWelcomeMessage';
export { ResearchProgressCard } from './components/ResearchProgressCard';
export { PlanPreviewCard } from './components/PlanPreviewCard';

// ── Chat hook ──
export { useAliaChat } from './hooks/useAliaChat';
export type { UseAliaChatOptions, UseAliaChatReturn } from './hooks/useAliaChat';

// ── Text-to-speech / speech-to-text (no livekit) ──
export { useTTS } from './hooks/useTTS';
export type { UseTTSOptions } from './hooks/useTTS';
export { useSpeechToText, useSTTStore } from './hooks/useSpeechToText';
export { VOICE_ERROR_MESSAGES } from './lib/speech-messages';
export type { VoiceErrorCode } from './lib/speech-messages';
export type { UseSTTOptions } from './hooks/useSpeechToText';

// ── Model catalogue (GET /catalogue) ──
// Exported so a consumer building its own picker reads the surface the SDK
// reads, rather than hardcoding an identifier the way this package used to.
export {
  fetchCatalogue,
  parseCatalogue,
  resolveSelection,
  resolveModelId,
  clearCatalogueCache,
} from './lib/catalogue';
export type { CatalogueEntry, CatalogueEntryKind, ModelSelection } from './lib/catalogue';
export { PREFERRED_CHAT_MODEL_ID, PREFERRED_VOICE_MODEL_ID } from './lib/config';

// ── Types ──
export type {
  ChatMessage,
  ToolInvocation,
  WelcomeSuggestion,
  ResearchProgress,
  ResearchSource,
  PendingPlan,
  PlanStep,
} from './types';

// ── Voice capability contract (the implementation lives in `./voice`) ──
export type {
  VoiceSessionComponent,
  VoiceSessionProps,
  VoiceSessionState,
} from './types';

// ── UI Primitives (NativeWind) ──
export { Button, buttonVariants, buttonTextVariants } from './components/ui/button';
export type { ButtonProps } from './components/ui/button';
export { Text, TextClassContext } from './components/ui/text';
export { cn, formatFileSize } from './lib/utils';
export { getToolLabel, getToolActiveLabel, getResearchActiveLabel } from './lib/tool-registry';
export { getTextFromContent, getImagesFromContent } from './lib/content-utils';

// ── Picker hooks ──
export { useImagePicker } from './hooks/useImagePicker';
export type { ImagePickerAsset } from './hooks/useImagePicker';
export { useDocumentPicker } from './hooks/useDocumentPicker';
export type { DocumentPickerResult } from './hooks/useDocumentPicker';

// ── Keyboard ──
export { KeyboardAwareScrollView, KeyboardAvoidingView, KeyboardProvider } from './lib/keyboard';

// ── Theme ──
export type { AliaColors } from './theme';
