import { create } from 'zustand';

/**
 * What `GET /memory` returns: the person's profile, not their memories. What
 * Alia remembers lives in the `memories` database of the person's Nilo
 * workspace.
 */
export interface UserMemory {
  settings: {
    recallEnabled: boolean;
  };
  preferences: {
    language?: string;
    tone?: string;
    voice?: string;
    responseLength?: 'short' | 'medium' | 'long';
    [key: string]: unknown;
  };
}

/**
 * Shared read surface for the user's memory profile. `useUserData` owns the
 * fetching and writes through to here. Nothing is persisted — a cached copy of
 * one account's profile must not survive on disk into the next sign-in.
 */
interface UserDataState {
  memory: UserMemory | null;
  setMemory: (memory: UserMemory) => void;
}

export const useUserDataStore = create<UserDataState>()((set) => ({
  memory: null,
  setMemory: (memory) => set({ memory }),
}));
