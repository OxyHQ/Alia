import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Memory {
  _id: string;
  title: string;
  summary: string;
  type: 'profile' | 'topic' | 'person';
  createdAt: string;
  updatedAt: string;
}

interface UserMemory {
  memories: Memory[];
  settings: {
    autoSaveEnabled: boolean;
    recallEnabled: boolean;
  };
  preferences: {
    language?: string;
    tone?: string;
    voice?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
    defaultAgentPermissions?: Record<string, boolean>;
    securityPreferences?: {
      requireApproval?: boolean;
      approvalTimeout?: number;
      autoDenyOnTimeout?: boolean;
    };
    [key: string]: unknown;
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
