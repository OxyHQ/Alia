import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import { useThemeStore, ThemeMode } from './stores/theme-store';
import { useEffect } from 'react';

// Theme colors in hex format for React Native components that don't support HSL
const THEME_COLORS = {
  light: {
    background: '#ffffff',
    foreground: '#0a0a0a',
    surface: '#fafafa',
    surfaceForeground: '#000000',
    primary: '#ca52e9',
    primaryForeground: '#ffffff',
    muted: '#f5f5f5',
    mutedForeground: '#737373',
    border: '#e5e5e5',
  },
  dark: {
    background: '#0a0d1a',
    foreground: '#fafafa',
    surface: '#242938',
    surfaceForeground: '#ffffff',
    primary: '#e952ca',
    primaryForeground: '#ffffff',
    muted: '#242938',
    mutedForeground: '#b3b3b3',
    border: 'rgba(255, 255, 255, 0.1)',
  },
};

export function useColorScheme() {
  const { colorScheme: nativeWindColorScheme, setColorScheme: setNativeWindColorScheme } = useNativeWindColorScheme();
  const { mode, setMode } = useThemeStore();

  // Sync NativeWind color scheme with our store
  useEffect(() => {
    setNativeWindColorScheme(mode);
  }, [mode, setNativeWindColorScheme]);

  const colorScheme = nativeWindColorScheme ?? 'light';

  const setColorScheme = (newMode: ThemeMode) => {
    setMode(newMode);
    setNativeWindColorScheme(newMode);
  };

  const toggleColorScheme = () => {
    const newMode = colorScheme === 'dark' ? 'light' : 'dark';
    setMode(newMode);
    setNativeWindColorScheme(newMode);
  };

  // Get theme colors for the current scheme
  const colors = THEME_COLORS[colorScheme];

  return {
    colorScheme,
    isDarkColorScheme: colorScheme === 'dark',
    setColorScheme,
    toggleColorScheme,
    mode, // Current mode setting (light/dark/system)
    colors, // Theme colors in hex format
  };
}
