/// <reference types="nativewind/types" />
// @alia.onl/sdk — Alia AI Chat SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main components ──
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';
export { AliaChatScreen } from './components/AliaChatScreen';
export type { AliaChatScreenProps } from './components/AliaChatScreen';

// ── Chat UI components ──
export { DEFAULT_LABELS } from './lib/labels';
export type { AliaChatLabels } from './lib/labels';
export { VoiceModeIcon } from './components/VoiceModeIcon';
export { AmbientField, PARALLAX_DURATION, PARALLAX_EASE } from './components/AmbientField';
export type { AmbientFieldProps } from './components/AmbientField';
export { AliaAvatar } from './components/AliaAvatar';
export type { AliaAvatarProps, AliaAvatarState } from './components/AliaAvatar';
export { IdentityMark } from './components/IdentityMark';
export type { IdentityMarkProps, IdentityMarkState } from './components/IdentityMark';
export { AliaMarkdown } from './components/Markdown';
export type { AliaMarkdownProps, RenderCodeBlock } from './components/Markdown';
export { AliaWelcomeMessage } from './components/AliaWelcomeMessage';
export { PlanPreviewCard } from './components/PlanPreviewCard';
export { QuestionCard } from './components/QuestionCard';
export { ComposerSuggestions } from './components/ComposerSuggestions';
export { useComposerSuggestions, useSuggestionQuery } from './hooks/useComposerSuggestions';
export { composerCompletions } from './lib/suggestions';
export type { Completion } from './lib/suggestions';
export {
  ASK_USER_QUESTION_TOOL,
  askedQuestions,
  formatAnswers,
  isQuestionInvocation,
} from './lib/questions';
export type { AskedOption, AskedQuestion, QuestionAnswer } from './lib/questions';

// ── Chat hook ──
export { useAliaChat } from './hooks/useAliaChat';
export type { UseAliaChatOptions, UseAliaChatReturn } from './hooks/useAliaChat';
export { AliaChatStreamError } from './lib/chat-stream';
export type { AliaChatFailure } from './lib/chat-stream';

// ── Text-to-speech / speech-to-text (no livekit) ──
export { useTTS } from './hooks/useTTS';
export type { UseTTSOptions } from './hooks/useTTS';
export { useSpeechToText, useSTTStore } from './hooks/useSpeechToText';
export { VOICE_ERROR_MESSAGES } from './lib/speech-messages';
export type { VoiceErrorCode } from './lib/speech-messages';
export type { UseSTTOptions } from './hooks/useSpeechToText';

// ── Model catalogue (GET /catalogue) ──
// Exported so a consumer building its own picker reads the real models the
// server offers; the SDK itself ships no model identifier.
export {
  fetchCatalogue,
  parseCatalogue,
  resolveSelection,
  resolveModelId,
  clearCatalogueCache,
} from './lib/catalogue';
export type { Catalogue, CatalogueEntry, ModelSelection, ReasoningEffort } from './lib/catalogue';

// ── Types ──
export type {
  ChatMessage,
  ToolInvocation,
  AliaSuggestion,
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
export { cn, formatFileSize } from './lib/utils';
export { getToolLabel, getToolActiveLabel, getResearchActiveLabel } from './lib/tool-registry';
export { getTextFromContent, getImagesFromContent } from './lib/content-utils';

// ── The turn's work log: tool calls as Bloom's `WebSearch` and `TaskList` ──
export { isWebInvocation, taskListLog, webSearchLog } from './lib/work-log';
export type { LiveResearch, TaskListLog, WebSearchLog, WorkLogOptions } from './lib/work-log';
export { englishWorkLog } from './lib/work-log-copy';
export type { Translate } from './lib/work-log-copy';
export { getToolDoneLabel, getToolPillLabel } from './lib/task-labels';
export { extractCitationSources } from './lib/citations';
export type { CitationSource } from './lib/citations';
export { toolCallStatus } from './lib/tool-call-status';
export type { ToolCallStatus } from './lib/tool-call-status';

// ── Picker hooks ──
export { useImagePicker } from './hooks/useImagePicker';
export type { ImagePickerAsset } from './hooks/useImagePicker';
export { useDocumentPicker } from './hooks/useDocumentPicker';
export type { DocumentPickerResult } from './hooks/useDocumentPicker';

// ── Keyboard ──
export { KeyboardAwareScrollView, KeyboardAvoidingView, KeyboardProvider } from './lib/keyboard';

// ── Theme ──
export type { AliaColors } from './theme';
