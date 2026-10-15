import { create } from 'zustand';
import type { FailedTurn } from './turn-failure';
import type { Message } from './types';

/** The thought panel's tabs. The store owns them because it owns which one opens. */
export type ThoughtTab = 'steps' | 'sources' | 'activity';

/**
 * Whether the conversation a selection belongs to has its messages yet. `loading` is the
 * seeded-then-upgraded window in which a message can be on screen without its tool history;
 * `failed` is a load that will not arrive. The panel shows each as itself instead of as "no steps".
 */
export type ThoughtScopeStatus = 'loading' | 'ready' | 'failed';

/**
 * The conversation a thought selection was made in, as the panel reads it.
 *
 * ## Why the messages travel WITH the selection
 *
 * The panel used to read one global array that the chat screen copied into only while the panel
 * was open. So the first press on a tool row rendered against whatever the array held — the
 * previous conversation, or nothing — and found no message by id: three empty tabs under five
 * visible tool rows. And with the new-chat screen mounted under a conversation, TWO chat screens
 * raced to write the array, and the empty one could win.
 *
 * Now a selection names its conversation and carries that conversation's messages, written in the
 * same update as the message id, and a later sync is accepted only from the SAME conversation. A
 * screen showing another conversation cannot blank what was opened from this one.
 */
export interface ThoughtScope {
  /** `null` for a conversation that has not been created yet — the first turn of a new chat. */
  conversationId: string | null;
  messages: Message[];
  status: ThoughtScopeStatus;
  /** A turn is in flight in this conversation. */
  isLoading: boolean;
  /** The turn that got no answer in this conversation, or `null`. */
  failedTurn: FailedTurn | null;
}

/** The turn the thought panel is about. */
export interface ThoughtSelection {
  messageId: string;
  /**
   * Which tab the panel opens on. A caller that already knows what the reader asked for — the
   * Sources row under an answer — says so, instead of landing them on Steps to go hunting.
   */
  tab: ThoughtTab;
  /** The conversation the message lives in. */
  scope: ThoughtScope;
}

interface ThoughtState {
  /** `null` while no turn is selected. */
  selection: ThoughtSelection | null;
  /**
   * Select a turn, with the conversation it was pressed in. One update: there is no render in
   * which the id is set and the messages are not.
   */
  open: (messageId: string, scope: ThoughtScope, tab?: ThoughtTab) => void;
  setTab: (tab: ThoughtTab) => void;
  /**
   * The chat screen's newest view of a conversation. Taken only when it is the conversation the
   * open selection belongs to; every other screen's write is dropped, which is what keeps a second
   * mounted chat from blanking the panel.
   */
  sync: (scope: ThoughtScope) => void;
  /** Clear the selection. */
  close: () => void;
}

/**
 * What the thought panel shows. Session state: the thread writes it, the panel (which the host
 * places — a right panel, a sheet) reads it.
 */
export const useThoughtStore = create<ThoughtState>()((set, get) => ({
  selection: null,

  open: (messageId, scope, tab = 'steps') => set({ selection: { messageId, tab, scope } }),

  setTab: (tab) => {
    const { selection } = get();
    if (selection !== null) set({ selection: { ...selection, tab } });
  },

  sync: (scope) => {
    const { selection } = get();
    if (selection === null || selection.scope.conversationId !== scope.conversationId) return;
    const held = selection.scope;
    if (
      held.messages === scope.messages &&
      held.status === scope.status &&
      held.isLoading === scope.isLoading &&
      held.failedTurn === scope.failedTurn
    )
      return;
    set({ selection: { ...selection, scope } });
  },

  close: () => {
    if (get().selection !== null) set({ selection: null });
  },
}));
