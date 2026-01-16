import { useState, useEffect } from 'react';
import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';

/**
 * Custom hook for using translations in components
 * Provides reactive translation updates when locale changes
 */
export function useTranslation() {
  const [locale, setLocale] = useState(i18n.locale);

  useEffect(() => {
    // Update locale from device settings
    const deviceLocale = getLocales()[0]?.languageCode ?? 'en';
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
   * @param newLocale - New locale code (e.g., 'en', 'es')
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
