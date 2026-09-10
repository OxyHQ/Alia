import { create } from "zustand";
import { AccountScopedKey } from "./account-scope";

interface FavoritesStoreState {
  favoriteConversationIds: string[];
  /**
   * Bind the store to the signed-in account and load its favourites. `null`
   * (signed out) empties the list and reads nothing. The layout calls this
   * whenever the user id changes; see `AccountScopedKey` for the namespace,
   * the one-time legacy migration and the stale-load guard.
   */
  loadFavorites: (userId: string | null) => Promise<void>;
  toggleFavorite: (conversationId: string) => Promise<void>;
  isFavorite: (conversationId: string) => boolean;
}

const storage = new AccountScopedKey("alia-favorite-conversations");

export const useFavoritesStore = create<FavoritesStoreState>((set, get) => ({
  favoriteConversationIds: [],

  loadFavorites: async (userId) => {
    // Empty synchronously: the previous account's favourites must not stay on
    // screen for the duration of the read, and a signed-out state has none.
    const token = storage.bind(userId);
    set({ favoriteConversationIds: [] });
    if (!userId) return;
    try {
      const favoritesData = await storage.getItem();
      if (!storage.isCurrent(token)) return;
      if (favoritesData) {
        const favorites = JSON.parse(favoritesData);
        set({ favoriteConversationIds: favorites });
      }
    } catch (error) {
      console.error("Error loading favorites:", error);
    }
  },

  toggleFavorite: async (conversationId: string) => {
    try {
      const state = get();
      const isFavorited = state.favoriteConversationIds.includes(conversationId);

      const newFavorites = isFavorited
        ? state.favoriteConversationIds.filter((id) => id !== conversationId)
        : [...state.favoriteConversationIds, conversationId];

      // Persist, then publish — unless the account changed while the write was
      // in flight, in which case the list belongs to the previous account.
      const token = storage.token;
      await storage.setItem(JSON.stringify(newFavorites));
      if (storage.isCurrent(token)) set({ favoriteConversationIds: newFavorites });
    } catch (error) {
      console.error("Error toggling favorite:", error);
    }
  },

  isFavorite: (conversationId: string) => {
    const state = get();
    return state.favoriteConversationIds.includes(conversationId);
  },
}));
