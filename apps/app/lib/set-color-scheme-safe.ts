import { colorScheme as nwColorScheme } from 'nativewind';
import { Appearance, Platform } from 'react-native';
import type { ThemeMode } from './stores/theme-store';

/**
 * Safely set NativeWind color scheme.
 * On Android (RN 0.83+), Appearance.setColorScheme has a Kotlin non-null
 * annotation on `style`. NativeWind passes null for 'system', which crashes.
 * Workaround: resolve the system preference and pass 'light'/'dark' instead.
 */
export function setColorSchemeSafe(mode: ThemeMode) {
  if (mode === 'system') {
    if (Platform.OS === 'android') {
      const resolved = Appearance.getColorScheme() ?? 'light';
      nwColorScheme.set(resolved);
    } else {
      nwColorScheme.set('system');
    }
  } else {
    nwColorScheme.set(mode);
  }
}
