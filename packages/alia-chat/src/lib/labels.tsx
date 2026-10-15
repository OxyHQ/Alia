import { createContext, type ReactNode, useContext, useMemo } from 'react';
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
  const value = useMemo(() => ({ ...DEFAULT_LABELS, ...labels }), [labels]);
  return <LabelsContext.Provider value={value}>{children}</LabelsContext.Provider>;
}

export function useLabels(): AliaChatLabels {
  return useContext(LabelsContext);
}
