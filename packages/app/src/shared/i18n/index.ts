import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import en from './locales/en.json';
import es from './locales/es.json';

/**
 * The exact locales this app ships a translation catalog for: one canonical
 * `language-REGION` tag per dictionary (`./locales/en.json`,
 * `./locales/es.json`). This is the single source of truth for that set —
 * consumed both below (to seed the `i18n-js` instance's alias keys) and by
 * `OxyProvider`'s `language` config in `app/_layout.tsx`, which resolves the
 * signed-in account's (or device's) locale down to one of these via
 * `coerceToSupportedLocale` (same-base-language match, e.g. an `es-MX`
 * account reads this `es-ES` catalog).
 */
export const SUPPORTED_LOCALES = ['en-US', 'es-ES'] as const;

/** Used when Oxy's resolved locale matches none of `SUPPORTED_LOCALES`. */
export const DEFAULT_LOCALE = 'en-US';

// Create i18n instance with translations
// Using BCP 47 locale codes (en-US, es-ES) with fallback to language codes (en, es)
const i18n = new I18n({
  'en': en,
  'en-US': en,
  'en-GB': en,
  'en-CA': en,
  'es': es,
  'es-ES': es,
  'es-MX': es,
  'es-AR': es,
});

/**
 * Get the device's current locale
 * Returns full locale code (e.g., "en-US") or falls back to language code (e.g., "en")
 */
function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) {
    return 'en-US';
  }

  // Try to use full locale code (e.g., "en-US")
  const fullLocale = locales[0]?.languageTag;
  if (fullLocale) {
    return fullLocale;
  }

  // Fallback to language code (e.g., "en")
  return locales[0]?.languageCode ?? 'en-US';
}

// Set the locale from device settings
i18n.locale = getDeviceLocale();

// Enable fallback to base language if specific regional variant is missing
// e.g., if es-MX is not found, it will try 'es', then 'en'
i18n.enableFallback = true;
i18n.missingBehavior = 'guess';

// Default locale
i18n.defaultLocale = DEFAULT_LOCALE;

export default i18n;
