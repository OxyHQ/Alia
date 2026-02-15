import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';

interface ModelState {
  selectedModel: string;
  baseModel: string; // Last non-thinking model (survives refresh)

  setSelectedModel: (model: string) => void;
  setBaseModel: (model: string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModel: 'alia-v1',
      baseModel: 'alia-v1',

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
