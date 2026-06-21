import i18n from '@/lib/i18n';
import { useI18nStore } from '@/lib/stores/i18n-store';

/**
 * Custom hook for using translations in components.
 * Uses Zustand store so locale changes propagate to ALL components.
 */
export function useTranslation() {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);

  const t = (key: string, params?: Record<string, any>) => {
    return i18n.t(key, params);
  };

  return { t, locale, changeLocale: setLocale };
}
