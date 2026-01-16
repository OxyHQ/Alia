import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import en from './locales/en.json';
import es from './locales/es.json';

// Create i18n instance
const i18n = new I18n({
  en,
  es,
});

// Set the locale once at the beginning of your app
i18n.locale = getLocales()[0]?.languageCode ?? 'en';

// Enable fallback to English if translation is missing
i18n.enableFallback = true;

// Default locale
i18n.defaultLocale = 'en';

export default i18n;
