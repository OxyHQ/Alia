import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { webLocalStorage, type BloomThemeStorage } from '@oxyhq/bloom/theme';

/**
 * Single source of truth for where Bloom persists the active theme
 * (`{ mode?, colorPreset? }` as JSON). `BloomThemeProvider` writes it; the key
 * lives here so writers and readers can never drift.
 */
export const BLOOM_THEME_PERSIST_KEY = 'alia.bloom.theme';

/**
 * Platform-selected storage adapter for Bloom theme persistence.
 *
 * - Web: `webLocalStorage` (synchronous `localStorage`), so Bloom can hydrate
 *   before the first paint, avoiding a palette flash.
 * - Native: `AsyncStorage`. Its `getItem`/`setItem`/`removeItem` signatures are
 *   already `BloomThemeStorage`-compatible, so it's passed directly.
 *
 * `webLocalStorage` is `undefined` on native by design, so the native branch
 * must supply the AsyncStorage adapter explicitly.
 */
export const BLOOM_THEME_STORAGE: BloomThemeStorage =
  Platform.OS === 'web' && webLocalStorage ? webLocalStorage : AsyncStorage;
