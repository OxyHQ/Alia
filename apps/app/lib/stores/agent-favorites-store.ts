import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface AgentFavoritesStoreState {
  favoriteAgentIds: string[];
  loadFavorites: () => Promise<void>;
  toggleFavorite: (agentId: string) => Promise<void>;
  isFavorite: (agentId: string) => boolean;
}

const STORAGE_KEY = "alia-favorite-agents";

export const useAgentFavoritesStore = create<AgentFavoritesStoreState>((set, get) => ({
  favoriteAgentIds: [],

  loadFavorites: async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      if (data) {
        set({ favoriteAgentIds: JSON.parse(data) });
      }
    } catch (error) {
      console.error("Error loading agent favorites:", error);
    }
  },

  toggleFavorite: async (agentId: string) => {
    try {
      const state = get();
      const isFavorited = state.favoriteAgentIds.includes(agentId);

      const newFavorites = isFavorited
        ? state.favoriteAgentIds.filter((id) => id !== agentId)
        : [...state.favoriteAgentIds, agentId];

      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newFavorites));
      set({ favoriteAgentIds: newFavorites });
    } catch (error) {
      console.error("Error toggling agent favorite:", error);
    }
  },

  isFavorite: (agentId: string) => {
    return get().favoriteAgentIds.includes(agentId);
  },
}));
