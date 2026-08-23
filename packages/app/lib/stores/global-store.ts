import { create } from "zustand";

export interface Attachment {
  id: string;
  uri: string;
  type: 'image' | 'document';
  name: string;
  size: number;
  mimeType: string;
  isLoading?: boolean;
}

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
}

/** Composer text handed to the screen identified by `target` (null = new-chat screen). */
export interface ComposerDraft {
  text: string;
  target: string | null;
  mcpServerId: string | null;
}

interface StoreState {
  scrollY: number;
  setScrollY: (value: number) => void;
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  updateAttachment: (id: string, updates: Partial<Attachment>) => void;
  removeAttachment: (id: string) => void;
  setAttachments: (attachments: Attachment[]) => void;
  clearAttachments: () => void;
  setBottomChatHeightHandler: (value: boolean) => void;
  bottomChatHeightHandler: boolean;
  chatId: ChatIdState;
  setChatId: (value: { id: string; from: "history" | "newChat" | "sidebar" | "url" } | null) => void;
  setFocusKeyboard: (value: boolean) => void;
  focusKeyboard: boolean;

  pendingInitialMessage: PendingInitialMessage | null;
  setPendingInitialMessage: (message: PendingInitialMessage) => void;
  clearPendingInitialMessage: () => void;

  /**
   * A composer draft handed to a chat screen by another route, or handed back
   * by a send that failed. Unlike {@link pendingInitialMessage} it is NOT sent —
   * it lands in the input for the user to finish. `target` names the screen it
   * belongs to so a draft never leaks into an unrelated chat, and
   * `composerDraftSeq` counts hand-offs so a screen can tell a fresh draft from
   * the copy it already applied.
   */
  composerDraft: ComposerDraft | null;
  composerDraftSeq: number;
  setComposerDraft: (draft: ComposerDraft) => void;
  clearComposerDraft: () => void;

  activeSkillId: string | null;
  setActiveSkillId: (skillId: string | null) => void;

  ghostMode: boolean;
  setGhostMode: (value: boolean) => void;

  agentMode: boolean;
  setAgentMode: (value: boolean) => void;

  deepResearchMode: boolean;
  setDeepResearchMode: (value: boolean) => void;

  streamingChatId: string | null;
  setStreamingChatId: (id: string | null) => void;
}

export const useStore = create<StoreState>((set, get) => ({
  scrollY: 0,
  setScrollY: (value: number) => set({ scrollY: value }),
  attachments: [],
  addAttachment: (attachment: Attachment) =>
    set((state) => ({
      attachments: [...state.attachments, attachment],
    })),
  updateAttachment: (id: string, updates: Partial<Attachment>) =>
    set((state) => ({
      attachments: state.attachments.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),
  removeAttachment: (id: string) =>
    set((state) => ({
      attachments: state.attachments.filter((a) => a.id !== id),
    })),
  setAttachments: (attachments: Attachment[]) => set({ attachments }),
  clearAttachments: () => set({ attachments: [] }),
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

  composerDraft: null,
  composerDraftSeq: 0,
  setComposerDraft: (draft: ComposerDraft) =>
    set((state) => ({ composerDraft: draft, composerDraftSeq: state.composerDraftSeq + 1 })),
  clearComposerDraft: () => set({ composerDraft: null }),

  activeSkillId: null,
  setActiveSkillId: (skillId: string | null) => set({ activeSkillId: skillId }),

  ghostMode: false,
  setGhostMode: (value: boolean) => set({ ghostMode: value }),

  agentMode: false,
  setAgentMode: (value: boolean) => set({ agentMode: value }),

  deepResearchMode: false,
  setDeepResearchMode: (value: boolean) => set({ deepResearchMode: value }),

  streamingChatId: null,
  setStreamingChatId: (id: string | null) => set({ streamingChatId: id }),
}));
