import { create } from "zustand";
import { AccountScopedKey } from "./account-scope";

interface PinnedStoreState {
  pinnedConversationIds: string[];
  /**
   * Bind the store to the signed-in account and load its pins. `null` (signed
   * out) empties the list and reads nothing. The layout calls this whenever
   * the user id changes; see `AccountScopedKey` for the namespace, the
   * one-time legacy migration and the stale-load guard.
   */
  loadPinned: (userId: string | null) => Promise<void>;
  togglePin: (conversationId: string) => Promise<void>;
  isPinned: (conversationId: string) => boolean;
}

const storage = new AccountScopedKey("alia-pinned-conversations");

export const usePinnedStore = create<PinnedStoreState>((set, get) => ({
  pinnedConversationIds: [],

  loadPinned: async (userId) => {
    // Empty synchronously: the previous account's pins must not stay on screen
    // for the duration of the read, and a signed-out state has none.
    const token = storage.bind(userId);
    set({ pinnedConversationIds: [] });
    if (!userId) return;
    try {
      const pinnedData = await storage.getItem();
      if (!storage.isCurrent(token)) return;
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

      // Persist, then publish — unless the account changed while the write was
      // in flight, in which case the list belongs to the previous account.
      const token = storage.token;
      await storage.setItem(JSON.stringify(newPinned));
      if (storage.isCurrent(token)) set({ pinnedConversationIds: newPinned });
    } catch (error) {
      console.error("Error toggling pin:", error);
    }
  },

  isPinned: (conversationId: string) => {
    const state = get();
    return state.pinnedConversationIds.includes(conversationId);
  },
}));
