import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface PinnedStoreState {
  pinnedConversationIds: string[];
  loadPinned: () => Promise<void>;
  togglePin: (conversationId: string) => Promise<void>;
  isPinned: (conversationId: string) => boolean;
}

const PINNED_STORAGE_KEY = "alia-pinned-conversations";

export const usePinnedStore = create<PinnedStoreState>((set, get) => ({
  pinnedConversationIds: [],

  loadPinned: async () => {
    try {
      const pinnedData = await AsyncStorage.getItem(PINNED_STORAGE_KEY);
      if (pinnedData) {
        const pinned = JSON.parse(pinnedData);
        set({ pinnedConversationIds: pinned });
      }
    } catch (error) {
      console.error("Error loading pinned:", error);
    }
  },

  togglePin: async (conversationId: string) => {
    try {
      const state = get();
      const isPinned = state.pinnedConversationIds.includes(conversationId);

      const newPinned = isPinned
        ? state.pinnedConversationIds.filter((id) => id !== conversationId)
        : [...state.pinnedConversationIds, conversationId];

      await AsyncStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(newPinned));
      set({ pinnedConversationIds: newPinned });
    } catch (error) {
      console.error("Error toggling pin:", error);
    }
  },

  isPinned: (conversationId: string) => {
    const state = get();
    return state.pinnedConversationIds.includes(conversationId);
  },
}));
