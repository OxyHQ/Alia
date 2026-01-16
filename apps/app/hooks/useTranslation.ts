import { useState, useEffect } from 'react';
import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';

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

/**
 * Custom hook for using translations in components
 * Provides reactive translation updates when locale changes
 */
export function useTranslation() {
  const [locale, setLocale] = useState(i18n.locale);

  useEffect(() => {
    // Update locale from device settings
    const deviceLocale = getDeviceLocale();
    if (deviceLocale !== i18n.locale) {
      i18n.locale = deviceLocale;
      setLocale(deviceLocale);
    }
  }, []);

  /**
   * Translate a key to the current locale
   * @param key - Translation key (e.g., 'auth.signIn')
   * @param params - Optional parameters for interpolation
   * @returns Translated string
   */
  const t = (key: string, params?: Record<string, any>) => {
    return i18n.t(key, params);
  };

  /**
   * Change the current locale
   * @param newLocale - New locale code (e.g., 'en-US', 'es-ES')
   */
  const changeLocale = (newLocale: string) => {
    i18n.locale = newLocale;
    setLocale(newLocale);
  };

  return {
    t,
    locale,
    changeLocale,
  };
}
