import { create } from 'zustand';

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

/**
 * Shared read surface for the user's memory document. `useUserData` owns the
 * fetching and writes through to here. Nothing is persisted — a cached copy of
 * one account's memories must not survive on disk into the next sign-in.
 */
interface UserDataState {
  memory: UserMemory | null;
  setMemory: (memory: UserMemory) => void;
}

export const useUserDataStore = create<UserDataState>()((set) => ({
  memory: null,
  setMemory: (memory) => set({ memory }),
}));
