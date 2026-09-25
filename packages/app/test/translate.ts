import { I18n } from 'i18n-js';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';

/**
 * The app's real catalogs behind the `useTranslation` shape, for tests.
 *
 * The hook itself cannot load here — its store reaches `expo-localization`
 * and AsyncStorage at import — so suites used to mock it as `(key) => key`,
 * which proves a component calls `t` and nothing about what a person reads.
 * This resolves through i18n-js and the shipped JSON instead, so a test can
 * assert the English (or Spanish) words and a missing key shows up as i18n-js's
 * own "[missing …]" text rather than passing as its key.
 *
 *   vi.mock('@/lib/hooks/use-translation', async () =>
 *     (await import('@/test/translate')).translationModule('en'));
 */
export function translator(locale: 'en' | 'es' = 'en') {
  const i18n = new I18n({ en, es });
  i18n.locale = locale;
  i18n.enableFallback = false;
  return (key: string, params?: Record<string, unknown>): string => i18n.t(key, params);
}

export function translationModule(locale: 'en' | 'es' = 'en') {
  const t = translator(locale);
  return {
    useTranslation: () => ({ t, locale, changeLocale: () => {} }),
  };
}
