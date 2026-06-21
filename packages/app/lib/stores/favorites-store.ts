import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface FavoritesStoreState {
  favoriteConversationIds: string[];
  loadFavorites: () => Promise<void>;
  toggleFavorite: (conversationId: string) => Promise<void>;
  isFavorite: (conversationId: string) => boolean;
}

const FAVORITES_STORAGE_KEY = "alia-favorite-conversations";

export const useFavoritesStore = create<FavoritesStoreState>((set, get) => ({
  favoriteConversationIds: [],

  loadFavorites: async () => {
    try {
      const favoritesData = await AsyncStorage.getItem(FAVORITES_STORAGE_KEY);
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

      await AsyncStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(newFavorites));
      set({ favoriteConversationIds: newFavorites });
    } catch (error) {
      console.error("Error toggling favorite:", error);
    }
  },

  isFavorite: (conversationId: string) => {
    const state = get();
    return state.favoriteConversationIds.includes(conversationId);
  },
}));
