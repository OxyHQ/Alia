import {
  useColorScheme as useNativeWindColorScheme,
  colorScheme as nwColorScheme,
} from 'nativewind';
import { Platform } from 'react-native';
import { useThemeStore, ThemeMode } from './stores/theme-store';
import { useCallback, useMemo } from 'react';
import { ACCENT_PRESETS } from './accent-presets';

const BASE_THEME_COLORS = {
  light: {
    background: '#ffffff',
    muted: '#f4f4f4',
    mutedForeground: '#727272',
  },
  dark: {
    background: '#030510',
    muted: '#2b3749',
    mutedForeground: '#b2b2b2',
  },
};

function applyTheme(resolved: 'light' | 'dark') {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }
}

export function useColorScheme() {
  const { colorScheme: nwScheme } = useNativeWindColorScheme();
  const { mode, setMode, accentColor } = useThemeStore();

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

  const colors = useMemo(() => ({
    ...BASE_THEME_COLORS[resolved],
    primary: ACCENT_PRESETS[accentColor].hex,
  }), [resolved, accentColor]);

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
  };
}
