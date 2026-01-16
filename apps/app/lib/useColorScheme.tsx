import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import { useThemeStore, ThemeMode } from './stores/theme-store';
import { useEffect } from 'react';

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

  return {
    colorScheme,
    isDarkColorScheme: colorScheme === 'dark',
    setColorScheme,
    toggleColorScheme,
    mode, // Current mode setting (light/dark/system)
  };
}
