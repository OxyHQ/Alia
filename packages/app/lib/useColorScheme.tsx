import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import { useCallback, useMemo } from 'react';
import { useBloomTheme, useTheme, type ThemeMode } from '@oxyhq/bloom/theme';

export type { ThemeMode };

/**
 * App-wide color-scheme hook.
 *
 * Resolved colors come from Bloom's `useTheme()` (`ThemeColors`), whose values
 * are already full `rgb(...)` strings — no manual HSL conversion. Light/dark
 * resolution and the active preset come from Bloom + NativeWind; `mode` /
 * `setColorScheme` proxy Bloom's `useBloomTheme()`.
 */
export function useColorScheme() {
  const { colorScheme: nwScheme } = useNativeWindColorScheme();
  const { mode, setMode } = useBloomTheme();
  const theme = useTheme();

  const effectiveMode: Exclude<ThemeMode, 'adaptive'> =
    mode === 'adaptive' ? 'system' : mode;
  // NativeWind's `colorScheme` is `ColorSchemeName` ('light' | 'dark' |
  // 'unspecified' | null | undefined); collapse anything that is not an
  // explicit 'dark' to 'light' for the system case.
  const resolved: 'light' | 'dark' =
    effectiveMode === 'system' ? (nwScheme === 'dark' ? 'dark' : 'light') : effectiveMode;

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
    },
    [setMode],
  );

  const colors = useMemo(() => {
    const c = theme.colors;
    return {
      background: c.background,
      // shadcn "foreground" is the primary text color.
      foreground: c.text,
      // Bloom 0.9.1 has no distinct surface token; surface ≈ card.
      surface: c.card,
      muted: c.backgroundSecondary,
      mutedForeground: c.textSecondary,
      border: c.border,
      primary: c.primary,
      primaryForeground: c.primaryForeground,
    };
  }, [theme]);

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
  };
}
