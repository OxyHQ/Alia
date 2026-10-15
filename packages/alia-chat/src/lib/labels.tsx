import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { VOICE_ERROR_MESSAGES, type VoiceErrorCode } from './speech-messages';
import { englishWorkLog, type Translate } from './work-log-copy';
import { VOICE_CONTROLS_LABELS, type VoiceControlsLabels } from './voice-controls-labels';
import type { VoiceCloseReason } from './voice-protocol';

/** Why a call could not be opened; the host's `canStartVoice` answers with one. */
export type VoiceBlockReason = 'sign-in' | 'plan-required' | 'credits-exhausted';

/** Every string the chat UI draws itself. Bloom's own copy follows `BloomProvider locale`. */
export interface AliaChatLabels {
  // Header
  clear: string;
  back: string;
  share: string;
  more: string;
  chatActions: string;
  // Composer
  placeholder: string;
  addMenuGroup: string;
  addPhotos: string;
  startVoice: string;
  /** The call bar's words (status, mute, end). */
  voiceControls: VoiceControlsLabels;
  /** Why a call ended without failing; `null` for a hang-up (the person knows). */
  voiceEnded: (reason: VoiceCloseReason) => string | null;
  /** Said once, and shown in the bar, when the call is about to reach its time limit. */
  voiceEndingSoon: string;
  /** Why a call was not opened, told instead of a button that silently does nothing. */
  voiceBlocked: (reason: VoiceBlockReason) => string;
  /** The field's accessible name. */
  composerMessage: string;
  /** The add button's accessible name. */
  composerAddMenu: string;
  /** The mode selector's accessible name (the host's power levels). */
  composerModes: string;
  /** The dictation button's accessible name. */
  composerVoice: string;
  composerSend: string;
  composerStop: string;
  /** A tile's remove button. */
  composerRemove: string;
  /** Bloom names a retry button "<this> <file name>". */
  composerRetry: string;
  /** What a tile without a file name is called. */
  composerUntitled: string;
  fileReadFailed: (name: string) => string;
  fileTooLarge: (name: string, limit: string) => string;
  fileEmpty: (name: string) => string;
  /** A file of a kind the chat cannot send (a document, where only photos go). */
  fileUnsupported: (name: string) => string;
  /** Over the composer while a file is dragged onto it. */
  dropHint: string;
  dropUnavailable: string;
  /** Why dictation failed, in the host's language. */
  voiceError: (code: VoiceErrorCode) => string;
  /** Over the composer in the last 30 s of a dictation's five minutes. */
  dictationRemaining: (seconds: number) => string;
  // Welcome
  /** The empty chat's greeting for a signed-out visitor. */
  greeting: string;
  /** The empty chat's greeting for a named person. */
  greetingNamed: (name: string) => string;
  // Messages
  copy: string;
  helpful: string;
  unhelpful: string;
  copied: string;
  edit: string;
  save: string;
  cancel: string;
  readAloud: string;
  stopReading: string;
  // Plan
  planTitle: string;
  planApprove: string;
  planCancel: string;
  planApproved: string;
  planCancelled: string;
  // Reasoning
  reasoning: string;
  thoughtFor: (seconds: number) => string;
  // The turn's work log
  /** The words of the tool log, keyed as the Alia app keys them (see `work-log-copy.ts`). */
  workLog: Translate;
  // Conversations (the runtime's own words: toasts and the errors it raises)
  /** A conversation's title until it has one. */
  newChat: string;
  /** A turn could not be sent and the composer got its text back. */
  sendFailed: string;
  /** The session ended mid-request. */
  signInRequired: string;
  conversationSaveFailed: string;
  conversationDeleteFailed: string;
  conversationCreateFailed: string;
  conversationClearFailed: string;
  /** An attachment of a kind the chat API does not carry was left out of the turn. */
  attachmentNotSent: (name: string) => string;
  /** A photo whose bytes could not be read was left out of the turn. */
  attachmentUnreadable: (name: string) => string;
  // Research
}

const ENDED_ENGLISH: Partial<Record<VoiceCloseReason, string>> = {
  'call-moved-elsewhere': 'The call continues on your other device',
  'max-duration': 'The call reached its time limit',
  'idle-timeout': 'The call ended after two minutes of silence',
  'credits-exhausted': 'The call ended: you ran out of credits',
  'server-shutdown': 'The call ended while Alia was updating — start a new one',
};

const BLOCKED_ENGLISH: Record<VoiceBlockReason, string> = {
  'sign-in': 'Sign in to use voice',
  'plan-required': 'Voice mode needs a paid plan',
  'credits-exhausted': "You've run out of credits",
};

export const DEFAULT_LABELS: AliaChatLabels = {
  clear: 'Clear',
  back: 'Back',
  share: 'Share',
  more: 'More',
  chatActions: 'Chat actions',
  placeholder: 'Ask Alia...',
  addMenuGroup: 'Add',
  addPhotos: 'Photos',
  startVoice: 'Start voice',
  voiceControls: VOICE_CONTROLS_LABELS,
  voiceEnded: (reason) => ENDED_ENGLISH[reason] ?? null,
  voiceEndingSoon: 'One minute left in this call',
  voiceBlocked: (reason) => BLOCKED_ENGLISH[reason],
  composerMessage: 'Message',
  composerAddMenu: 'Add to chat',
  composerModes: 'Power level',
  composerVoice: 'Dictate',
  composerSend: 'Send message',
  composerStop: 'Stop generating',
  composerRemove: 'Remove',
  composerRetry: 'Retry',
  composerUntitled: 'untitled',
  fileReadFailed: (name) => `${name} could not be read — select to try again`,
  fileTooLarge: (name, limit) => `${name} is larger than ${limit} and was not attached`,
  fileEmpty: (name) => `${name} is empty — folders can't be attached`,
  fileUnsupported: (name) => `${name} can't be sent here — only photos can`,
  dropHint: 'Drop files here to attach them',
  dropUnavailable: "Files can't be attached right now",
  voiceError: (code) => VOICE_ERROR_MESSAGES[code],
  dictationRemaining: (seconds) => `${seconds}s of dictation left`,
  greeting: "Hi, what's on your mind?",
  greetingNamed: (name) => `Hi ${name}, what's on your mind?`,
  copy: 'Copy',
  helpful: 'Helpful response',
  unhelpful: 'Unhelpful response',
  copied: 'Copied',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  readAloud: 'Read aloud',
  stopReading: 'Stop reading',
  planTitle: "Here's my plan",
  planApprove: 'Approve',
  planCancel: 'Cancel',
  planApproved: 'Plan approved',
  planCancelled: 'Plan cancelled',
  reasoning: 'Reasoning',
  thoughtFor: (seconds) => `Thought for ${seconds} seconds`,
  workLog: englishWorkLog,
  newChat: 'New chat',
  sendFailed: "Your message couldn't be sent",
  signInRequired: 'Sign in to keep chatting',
  conversationSaveFailed: 'Failed to save conversation',
  conversationDeleteFailed: 'Failed to delete conversation',
  conversationCreateFailed: 'Failed to create conversation',
  conversationClearFailed: "The conversation couldn't be cleared",
  attachmentNotSent: (name) => `${name} wasn't sent — only photos can be sent`,
  attachmentUnreadable: (name) => `${name} couldn't be read and wasn't sent`,
};

const LabelsContext = createContext<AliaChatLabels>(DEFAULT_LABELS);

/** The chat's labels: the defaults, with whatever the host overrides. */
export function AliaChatLabelsProvider({
  labels,
  children,
}: {
  labels?: Partial<AliaChatLabels>;
  children: ReactNode;
}) {
  // Over whatever labels are already in reach, so a part that takes its own `labels` (the
  // composer) refines the chat's copy instead of resetting it to English.
  const inherited = useContext(LabelsContext);
  const value = useMemo(() => ({ ...inherited, ...labels }), [inherited, labels]);
  return <LabelsContext.Provider value={value}>{children}</LabelsContext.Provider>;
}

export function useLabels(): AliaChatLabels {
  return useContext(LabelsContext);
}
