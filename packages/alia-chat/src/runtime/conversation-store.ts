import { create } from 'zustand';
import type { AliaAttachment } from '../types';
import type { MessageContent } from './types';

/**
 * A first message queued for a conversation that was just created. `content` is
 * what gets sent; `text` and `attachments` are the raw composer state, kept so a
 * failed send can hand them back to the input.
 */
export interface PendingInitialMessage {
  /** The conversation the message was queued for; only its thread sends it. */
  conversationId: string;
  content: MessageContent;
  text: string;
  attachments: AliaAttachment[];
  mcpServerId: string | null;
  /** The skills chosen for that message, carried across the screen hand-off. */
  skillNames: string[];
}

interface ConversationStoreState {
  /**
   * The first message of a conversation that was created a moment ago. The
   * conversation opens (a route, a sheet) and the message is sent from there,
   * so the thread the person lands on is the one being answered.
   */
  pendingInitialMessage: PendingInitialMessage | null;
  setPendingInitialMessage: (message: PendingInitialMessage) => void;
  clearPendingInitialMessage: () => void;

  /** The conversation a turn is streaming into right now, for a list to show a spinner on its row. */
  streamingConversationId: string | null;
  setStreamingConversationId: (id: string | null) => void;
}

/**
 * Conversation state that outlives one open screen and is read from several:
 * the hand-off of a first message, and which row is streaming. Shared by every
 * surface that mounts the runtime, so a sidebar beside a thread reads what the
 * thread is doing.
 */
export const useConversationStore = create<ConversationStoreState>((set) => ({
  pendingInitialMessage: null,
  setPendingInitialMessage: (message) => set({ pendingInitialMessage: message }),
  clearPendingInitialMessage: () => set({ pendingInitialMessage: null }),

  streamingConversationId: null,
  setStreamingConversationId: (id) => set({ streamingConversationId: id }),
}));
