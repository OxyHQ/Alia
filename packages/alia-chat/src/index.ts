/// <reference types="nativewind/types" />
// @alia.onl/sdk — Alia AI Chat SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main components ──
export { AliaChatContent } from './components/AliaChatContent';
export type {
  AliaChatAgentRef,
  AliaChatChrome,
  AliaChatContentProps,
  AliaChatState,
} from './components/AliaChatContent';
export { AliaParticipants, useParticipants } from './components/AliaParticipants';
export type { AliaParticipantsProps, UseParticipantsOptions } from './components/AliaParticipants';
export { AliaParticipantsHeader } from './components/AliaParticipantsHeader';
export type { AliaParticipantsHeaderProps } from './components/AliaParticipantsHeader';
export { ALIA_LEAD, leadOf } from './lib/participants';
export type { AliaChatParticipants, AliaLead, AliaParticipant } from './lib/participants';
export { ANCHORS, leadToProfile } from './lib/flights';
export { parseCatalogueTool, toolRendererKey } from './lib/tool-renderers';
export type { AliaToolRenderers, AliaToolResult } from './lib/tool-renderers';
export { AliaAskProvider, useAskAgent } from './components/AliaAskProvider';
export type { AliaAsk, AliaAskAgents, AliaAskProviderProps } from './components/AliaAskProvider';
export { AliaSharedConversation } from './components/AliaSharedConversation';
export type { AliaSharedConversationProps } from './components/AliaSharedConversation';
export type { AliaAddMenu } from './lib/add-menu';
export type { AliaVoiceOptions } from './hooks/useChatVoice';
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';
export { AliaRecentConversations } from './components/AliaRecentConversations';
export type { AliaTurn } from './hooks/useChatComposer';
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
export { ReplyMarkdown } from './components/ReplyMarkdown';
export { AliaThread } from './components/thread/AliaThread';
export type { AliaThreadProps, NewConversationOfferProps } from './components/thread/AliaThread';
export { ThoughtPanel } from './components/thought/ThoughtPanel';
export type { ThoughtPanelProps } from './components/thought/ThoughtPanel';
export type { OutputActions } from './components/thought/FilesAndSources';
export { CanvasComponent } from './components/canvas/CanvasComponent';
export { restoreOpenerFocus } from './lib/focus-return';
export { buildPowerLevelOptions, POWER_LEVEL_ICONS } from './lib/power-level-options';
export type { DeviceModel } from './lib/power-level-options';
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

// ── Conversation runtime: the one data layer under the sheet, the screen and the Alia app ──
export * from './runtime';

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

// ── Types ──
export type {
  AliaAttachment,
  AliaSuggestion,
  ResearchProgress,
  ResearchSource,
  MessagePlan,
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
