import { create } from "zustand";
import type { Attachment } from "@/shared/contracts/chat-turn";

export type ChatIdState = {
  id: string;
  from: "history" | "newChat" | "sidebar" | "url";
} | null;

/** What a message carries to the model: plain text, or multi-part once images are attached. */
export type MessageContent = string | Array<{ type: string; [key: string]: unknown }>;

/**
 * A first message queued for a conversation that was just created. `content` is
 * what gets sent; `text` and `attachments` are the raw composer state, kept so a
 * failed send can hand them back to the input.
 */
export interface PendingInitialMessage {
  content: MessageContent;
  text: string;
  attachments: Attachment[];
  mcpServerId: string | null;
  /** The skills chosen for that message, carried across the screen hand-off. */
  skillNames: string[];
}

interface StoreState {
  scrollY: number;
  setScrollY: (value: number) => void;
  setBottomChatHeightHandler: (value: boolean) => void;
  bottomChatHeightHandler: boolean;
  chatId: ChatIdState;
  setChatId: (value: { id: string; from: "history" | "newChat" | "sidebar" | "url" } | null) => void;
  setFocusKeyboard: (value: boolean) => void;
  focusKeyboard: boolean;

  pendingInitialMessage: PendingInitialMessage | null;
  setPendingInitialMessage: (message: PendingInitialMessage) => void;
  clearPendingInitialMessage: () => void;

  ghostMode: boolean;
  setGhostMode: (value: boolean) => void;

  agentMode: boolean;
  setAgentMode: (value: boolean) => void;

  deepResearchMode: boolean;
  setDeepResearchMode: (value: boolean) => void;

  streamingChatId: string | null;
  setStreamingChatId: (id: string | null) => void;
}

export const useStore = create<StoreState>((set) => ({
  scrollY: 0,
  setScrollY: (value: number) => set({ scrollY: value }),
  bottomChatHeightHandler: false,
  setBottomChatHeightHandler: (value: boolean) =>
    set({ bottomChatHeightHandler: value }),
  chatId: null,
  setChatId: (value) => set({ chatId: value }),
  focusKeyboard: false,
  setFocusKeyboard: (value: boolean) => set({ focusKeyboard: value }),

  pendingInitialMessage: null,
  setPendingInitialMessage: (message: PendingInitialMessage) => set({ pendingInitialMessage: message }),
  clearPendingInitialMessage: () => set({ pendingInitialMessage: null }),

  ghostMode: false,
  setGhostMode: (value: boolean) => set({ ghostMode: value }),

  agentMode: false,
  setAgentMode: (value: boolean) => set({ agentMode: value }),

  deepResearchMode: false,
  setDeepResearchMode: (value: boolean) => set({ deepResearchMode: value }),

  streamingChatId: null,
  setStreamingChatId: (id: string | null) => set({ streamingChatId: id }),
}));
