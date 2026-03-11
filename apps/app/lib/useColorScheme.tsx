import {
  useColorScheme as useNativeWindColorScheme,
  colorScheme as nwColorScheme,
} from 'nativewind';
import { Platform } from 'react-native';
import { useThemeStore, ThemeMode } from './stores/theme-store';
import { useCallback, useEffect, useMemo } from 'react';
import { APP_COLOR_PRESETS } from './app-color-presets';

/** Convert an HSL CSS variable value like "153 50% 5%" to "hsl(153, 50%, 5%)".
 *  Also handles alpha syntax "0 0% 100% / 10%" → "hsla(0, 0%, 100%, 0.1)". */
function hslVarToCSS(value: string): string {
  const parts = value.split('/').map((s) => s.trim());
  if (parts.length === 2) {
    const alpha = parseFloat(parts[1]) / 100;
    return `hsla(${parts[0].replace(/ /g, ', ')}, ${alpha})`;
  }
  return `hsl(${value.replace(/ /g, ', ')})`;
}

function applyTheme(resolved: 'light' | 'dark') {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }
}

export function useColorScheme() {
  const { colorScheme: nwScheme } = useNativeWindColorScheme();
  const { mode, setMode, appColor } = useThemeStore();

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (nwScheme ?? 'light') : mode;

  // Keep the dark class in sync on web for all modes (including system)
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
      nwColorScheme.set(newMode);
    },
    [setMode],
  );

  const colors = useMemo(() => {
    const preset = APP_COLOR_PRESETS[appColor];
    const vars = resolved === 'light' ? preset.light : preset.dark;
    return {
      background: hslVarToCSS(vars['--background']),
      sidebar: hslVarToCSS(vars['--sidebar']),
      surface: hslVarToCSS(vars['--surface']),
      muted: hslVarToCSS(vars['--muted']),
      mutedForeground: hslVarToCSS(vars['--muted-foreground']),
      border: hslVarToCSS(vars['--border']),
      primary: preset.hex,
    };
  }, [resolved, appColor]);

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
  };
}
