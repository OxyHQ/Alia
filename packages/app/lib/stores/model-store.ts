import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_MODEL_ID } from '@/lib/config';

/**
 * What the user last chose, across app launches.
 *
 * The store holds the REQUESTED identifier and never validates it: the
 * catalogue is the authority on what exists, it is fetched rather than
 * persisted, and `resolveSelection` (`lib/hooks/use-catalogue.ts`) is where a
 * selection the product no longer offers is answered for.
 */
interface ModelState {
  selectedModel: string;
  baseModel: string; // Last non-thinking model (survives refresh)

  setSelectedModel: (model: string) => void;
  setBaseModel: (model: string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModel: DEFAULT_MODEL_ID,
      baseModel: DEFAULT_MODEL_ID,

      setSelectedModel: (model) =>
        set({ selectedModel: model }),

      setBaseModel: (model) =>
        set({ baseModel: model }),
    }),
    {
      name: 'chat-storage', // keep same key for backwards compat
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
