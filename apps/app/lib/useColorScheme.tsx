import {
  useColorScheme as useNativeWindColorScheme,
  colorScheme as nwColorScheme,
} from 'nativewind';
import { Platform } from 'react-native';
import { useThemeStore, ThemeMode } from './stores/theme-store';
import { useCallback } from 'react';

const THEME_COLORS = {
  light: {
    background: '#ffffff',
    primary: '#ca52e9',
    muted: '#f5f5f5',
    mutedForeground: '#737373',
  },
  dark: {
    background: '#0a0d1a',
    primary: '#ca52e9',
    muted: '#242938',
    mutedForeground: '#b3b3b3',
  },
};

function applyTheme(resolved: 'light' | 'dark') {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }
}

export function useColorScheme() {
  const { colorScheme: nwScheme } = useNativeWindColorScheme();
  const { mode, setMode } = useThemeStore();

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (nwScheme ?? 'light') : mode;

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
      nwColorScheme.set(newMode);
      if (newMode !== 'system') {
        applyTheme(newMode);
      }
    },
    [setMode],
  );

  const colors = THEME_COLORS[resolved];

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
  };
}
