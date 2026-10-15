import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { VOICE_ERROR_MESSAGES, type VoiceErrorCode } from './speech-messages';
import { englishWorkLog, type Translate } from './work-log-copy';

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
  voiceFailed: string;
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
  // Research
}

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
  voiceFailed: "Couldn't start the voice call",
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
