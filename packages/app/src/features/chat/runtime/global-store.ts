import { create } from 'zustand';

export type ChatIdState = {
  id: string;
  from: 'history' | 'newChat' | 'sidebar' | 'url';
} | null;

interface StoreState {
  scrollY: number;
  setScrollY: (value: number) => void;
  setBottomChatHeightHandler: (value: boolean) => void;
  bottomChatHeightHandler: boolean;
  chatId: ChatIdState;
  setChatId: (
    value: { id: string; from: 'history' | 'newChat' | 'sidebar' | 'url' } | null,
  ) => void;
  setFocusKeyboard: (value: boolean) => void;
  focusKeyboard: boolean;

  ghostMode: boolean;
  setGhostMode: (value: boolean) => void;

  agentMode: boolean;
  setAgentMode: (value: boolean) => void;

  deepResearchMode: boolean;
  setDeepResearchMode: (value: boolean) => void;
}

export const useStore = create<StoreState>((set) => ({
  scrollY: 0,
  setScrollY: (value: number) => set({ scrollY: value }),
  bottomChatHeightHandler: false,
  setBottomChatHeightHandler: (value: boolean) => set({ bottomChatHeightHandler: value }),
  chatId: null,
  setChatId: (value) => set({ chatId: value }),
  focusKeyboard: false,
  setFocusKeyboard: (value: boolean) => set({ focusKeyboard: value }),

  ghostMode: false,
  setGhostMode: (value: boolean) => set({ ghostMode: value }),

  agentMode: false,
  setAgentMode: (value: boolean) => set({ agentMode: value }),

  deepResearchMode: false,
  setDeepResearchMode: (value: boolean) => set({ deepResearchMode: value }),
}));
