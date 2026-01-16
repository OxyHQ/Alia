import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import en from './locales/en.json';
import es from './locales/es.json';

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
  return locales[0]?.languageCode ?? 'en';
}

// Set the locale from device settings
i18n.locale = getDeviceLocale();

// Enable fallback to base language if specific regional variant is missing
// e.g., if es-MX is not found, it will try 'es', then 'en'
i18n.enableFallback = true;

// Default locale
i18n.defaultLocale = 'en-US';

export default i18n;
