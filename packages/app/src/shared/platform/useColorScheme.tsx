import { useBloomTheme, useTheme, type ThemeMode } from '@oxy.so/bloom/theme';
import { useCallback, useMemo } from 'react';

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
  const { mode, setMode } = useBloomTheme();
  const theme = useTheme();

  const resolved = theme.mode;

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
      // Existing surface consumers use the shared card surface.
      surface: c.card,
      muted: c.backgroundSecondary,
      mutedForeground: c.textSecondary,
      border: c.border,
      primary: c.primary,
      primaryForeground: c.primaryForeground,
      // The status hues, for the few places that must tell one KIND of thing
      // from another by colour — a file-type chip, say. They are surfaced here
      // rather than reached for through Bloom directly so that
      // `useColorScheme().colors` stays the single seam the styling rules point
      // at, and so nothing is tempted back into a literal hex.
      error: c.error,
      success: c.success,
      warning: c.warning,
      info: c.info,
      secondary: c.secondary,
      tertiary: c.tertiary,
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
