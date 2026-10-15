/// <reference types="nativewind/types" />
// @alia.onl/sdk — Alia AI Chat SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main components ──
export type { AliaChatAgent, AliaChatState, AliaVoiceOptions } from './components/AliaChatContent';
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';
export type { AliaTurn } from './components/AliaChatContent';
export { AliaChatScreen } from './components/AliaChatScreen';
export type { AliaChatScreenProps } from './components/AliaChatScreen';

// ── Chat UI components ──
export { ALIA_CHARACTER_RUNTIME_URL } from './lib/character-runtime';
export { DEFAULT_LABELS } from './lib/labels';
export { AliaChatLabelsProvider, useLabels } from './lib/labels';
export type { AliaChatLabels, VoiceBlockReason } from './lib/labels';
export { VoiceModeIcon } from './components/VoiceModeIcon';
export { AmbientField, PARALLAX_DURATION, PARALLAX_EASE } from './components/AmbientField';
export type { AmbientFieldProps } from './components/AmbientField';
export { ALIA_AVATAR, AliaAvatar } from './components/AliaAvatar';
export { DEFAULT_AGENT_CHARACTER, readAgentCharacter } from './lib/agent-character';
export type { AliaAvatarProps, AliaAvatarState } from './components/AliaAvatar';
export { AliaAvatarIcon } from './components/AliaAvatarIcon';
export { useAliaActivity } from './hooks/useAliaActivity';
export type { UseAliaActivityOptions } from './hooks/useAliaActivity';
export { IdentityMark } from './components/IdentityMark';
export type { IdentityMarkProps, IdentityMarkState } from './components/IdentityMark';
export { AliaMarkdown } from './components/Markdown';
export type { AliaMarkdownProps, RenderCodeBlock } from './components/Markdown';
export { AliaWelcomeMessage } from './components/AliaWelcomeMessage';
export { PlanPreviewCard } from './components/PlanPreviewCard';
export { AskedQuestions, QuestionCard } from './components/QuestionCard';
export { AliaComposer } from './components/AliaComposer';
export type {
  AliaComposerProps,
  AliaComposerQuestions,
  AliaComposerSuggestions,
} from './components/AliaComposer';
export { ComposerSuggestions } from './components/ComposerSuggestions';
export { usePendingQuestions } from './hooks/usePendingQuestions';
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

// ── Read aloud and dictation (no call, no audio engine) ──
export { useTTS } from './hooks/useTTS';
export type { UseTTSOptions } from './hooks/useTTS';
export { useDictation, useDictationStore } from './hooks/useDictation';
export type { UseDictationOptions, DictationState } from './hooks/useDictation';
export { DictationError, requestTranscription } from './lib/dictation';
export type { DictationErrorCode, TranscriptionResult } from './lib/dictation';
export { VOICE_ERROR_MESSAGES } from './lib/speech-messages';
export type { VoiceErrorCode } from './lib/speech-messages';
export { SpeechClipError } from './lib/speech-synthesis';
export type { SpeechClipErrorCode } from './lib/speech-synthesis';

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
  AliaAttachment,
  AliaSuggestion,
  ResearchProgress,
  ResearchSource,
  PendingPlan,
  PlanStep,
} from './types';

// ── Voice: part of the conversation screen; the host brings callbacks (see `AliaVoiceOptions`) ──
export type { VoiceNotice, VoiceSessionProps, VoiceSessionState } from './types';
export { AliaVoiceCall } from './components/voice/AliaVoiceCall';
export { useVoiceLauncher, toastNotice } from './hooks/useVoiceLauncher';
export type { UseVoiceLauncherOptions, VoiceLauncher } from './hooks/useVoiceLauncher';

// ── UI Primitives (NativeWind) ──
export { cn, formatFileSize } from './lib/utils';
export { getToolLabel, getToolActiveLabel, getResearchActiveLabel } from './lib/tool-registry';
export { getTextFromContent, getImagesFromContent } from './lib/content-utils';

// ── The turn's work log: tool calls as Bloom's `WebSearch` and `TaskList` ──
export { isWebInvocation, taskListLog, webSearchLog } from './lib/work-log';
export type { LiveResearch, TaskListLog, WebSearchLog, WorkLogOptions } from './lib/work-log';
// The pure parts (call status, citations, tool labels, `Translate`) are `@alia.onl/sdk/tools`.

// ── Picker hooks ──
export { useImagePicker } from './hooks/useImagePicker';
export type { ImagePickerAsset } from './hooks/useImagePicker';
export { useDocumentPicker } from './hooks/useDocumentPicker';
export type { DocumentPickerResult } from './hooks/useDocumentPicker';

// ── Keyboard ──
export { KeyboardAwareScrollView, KeyboardAvoidingView, KeyboardProvider } from './lib/keyboard';

// ── Theme ──
export type { AliaColors } from './theme';
