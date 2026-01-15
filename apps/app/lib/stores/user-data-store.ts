import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Memory {
  _id: string;
  key: string;
  value: string;
  category?: string;
  createdAt: string;
  updatedAt: string;
}

interface UserMemory {
  memories: Memory[];
  preferences: {
    language?: string;
    tone?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
  };
  context: {
    occupation?: string;
    location?: string;
    bio?: string;
    timezone?: string;
  };
}

interface UserDataState {
  memory: UserMemory | null;
  loading: boolean;
  lastFetch: number | null;

  // Actions
  setMemory: (memory: UserMemory) => void;
  setLoading: (loading: boolean) => void;
  clearMemory: () => void;
  shouldRefetch: () => boolean;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useUserDataStore = create<UserDataState>()(
  persist(
    (set, get) => ({
      memory: null,
      loading: false,
      lastFetch: null,

      setMemory: (memory) =>
        set({
          memory,
          lastFetch: Date.now(),
        }),

      setLoading: (loading) =>
        set({ loading }),

      clearMemory: () =>
        set({
          memory: null,
          lastFetch: null,
        }),

      // Check if we should refetch data (cache expired)
      shouldRefetch: () => {
        const { lastFetch } = get();
        if (!lastFetch) return true;
        return Date.now() - lastFetch > CACHE_DURATION;
      },
    }),
    {
      name: 'user-data-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        memory: state.memory,
        lastFetch: state.lastFetch,
      }),
    }
  )
);
