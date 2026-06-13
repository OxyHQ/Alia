import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import { useCallback, useMemo } from 'react';
import { APP_COLOR_PRESETS, useBloomTheme, type ThemeMode } from '@oxyhq/bloom/theme';

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

export type { ThemeMode };

export function useColorScheme() {
  const { colorScheme: nwScheme } = useNativeWindColorScheme();
  const { mode, setMode, colorPreset } = useBloomTheme();

  const resolved: 'light' | 'dark' =
    mode === 'system' || mode === 'adaptive'
      ? (nwScheme === 'dark' ? 'dark' : 'light')
      : mode;

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
    },
    [setMode],
  );

  const colors = useMemo(() => {
    const preset = APP_COLOR_PRESETS[colorPreset];
    const tokens = resolved === 'light' ? preset.light : preset.dark;
    return {
      background: hslVarToCSS(tokens['--background']),
      foreground: hslVarToCSS(tokens['--foreground']),
      sidebar: hslVarToCSS(tokens['--sidebar']),
      surface: hslVarToCSS(tokens['--surface']),
      muted: hslVarToCSS(tokens['--muted']),
      mutedForeground: hslVarToCSS(tokens['--muted-foreground']),
      border: hslVarToCSS(tokens['--border']),
      primary: preset.hex,
      primaryForeground: hslVarToCSS(tokens['--primary-foreground']),
    };
  }, [resolved, colorPreset]);

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
  };
}
