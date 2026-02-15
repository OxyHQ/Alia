import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorScheme as nwColorScheme } from 'nativewind';
import { Platform } from 'react-native';
import { type AccentColorName, applyAccentToDocument } from '../accent-presets';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  accentColor: AccentColorName;
  setMode: (mode: ThemeMode) => void;
  setAccentColor: (color: AccentColorName) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      accentColor: 'default',
      setMode: (mode: ThemeMode) => set({ mode }),
      setAccentColor: (accentColor: AccentColorName) => set({ accentColor }),
    }),
    {
      name: 'theme-storage',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        if (!state?.mode) return;
        nwColorScheme.set(state.mode);
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
          const resolved = state.mode === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : state.mode;
          document.documentElement.classList.toggle('dark', resolved === 'dark');
          if (state.accentColor && state.accentColor !== 'default') {
            applyAccentToDocument(state.accentColor, resolved as 'light' | 'dark');
          }
        }
      },
    }
  )
);
