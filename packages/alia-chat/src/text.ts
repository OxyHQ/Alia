// @alia.onl/sdk/text — the chat without the voice call, and without bundling it
// The same `AliaChatSheet`, `AliaChatScreen` and `AliaChatContent` as the root entry, but none of
// them reaches the call's modules (its socket, protocol and audio engine): a text-only app takes
// its chat from here. Read-aloud and dictation stay — they are the composer's and the thread's.
// Types can be imported from the root entry (they are erased); values from the root would bring
// the call along.

export { AliaChatContent } from './components/AliaChatContent';
export type {
  AliaChatAgentRef,
  AliaChatChrome,
  AliaChatContentProps,
  AliaChatState,
} from './components/AliaChatContent';
export { AliaChatSheet } from './components/AliaChatSheet';
export type { AliaChatSheetProps, AliaChatSheetRef } from './components/AliaChatSheet';
export { AliaChatScreen } from './components/AliaChatScreen';
export type { AliaChatScreenProps } from './components/AliaChatScreen';
