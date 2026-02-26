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

type ChatIdState = {
  id: string;
  from: "history" | "newChat" | "sidebar" | "url";
} | null;

interface StoreState {
  scrollY: number;
  setScrollY: (value: number) => void;
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  updateAttachment: (id: string, updates: Partial<Attachment>) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setBottomChatHeightHandler: (value: boolean) => void;
  bottomChatHeightHandler: boolean;
  chatId: ChatIdState;
  setChatId: (value: { id: string; from: "history" | "newChat" | "sidebar" | "url" } | null) => void;
  setFocusKeyboard: (value: boolean) => void;
  focusKeyboard: boolean;

  pendingInitialMessage: string | Array<{ type: string; [key: string]: any }> | null;
  setPendingInitialMessage: (message: string | Array<{ type: string; [key: string]: any }>) => void;
  clearPendingInitialMessage: () => void;

  activeSkillId: string | null;
  setActiveSkillId: (skillId: string | null) => void;

  ghostMode: boolean;
  setGhostMode: (value: boolean) => void;

  agentMode: boolean;
  setAgentMode: (value: boolean) => void;

  deepResearchMode: boolean;
  setDeepResearchMode: (value: boolean) => void;
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
  clearAttachments: () => set({ attachments: [] }),
  bottomChatHeightHandler: false,
  setBottomChatHeightHandler: (value: boolean) =>
    set({ bottomChatHeightHandler: value }),
  chatId: null,
  setChatId: (value) => set({ chatId: value }),
  focusKeyboard: false,
  setFocusKeyboard: (value: boolean) => set({ focusKeyboard: value }),

  pendingInitialMessage: null,
  setPendingInitialMessage: (message: string | Array<{ type: string; [key: string]: any }>) => set({ pendingInitialMessage: message }),
  clearPendingInitialMessage: () => set({ pendingInitialMessage: null }),

  activeSkillId: null,
  setActiveSkillId: (skillId: string | null) => set({ activeSkillId: skillId }),

  ghostMode: false,
  setGhostMode: (value: boolean) => set({ ghostMode: value }),

  agentMode: false,
  setAgentMode: (value: boolean) => set({ agentMode: value }),

  deepResearchMode: false,
  setDeepResearchMode: (value: boolean) => set({ deepResearchMode: value }),
}));
