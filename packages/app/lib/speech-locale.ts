import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';

/**
 * The language speech is recognized in: the app's, not the device's.
 *
 * A person who reads Alia in Spanish expects to dictate and talk to it in
 * Spanish whatever their phone is set to, so this follows `i18n.locale` — which
 * `OxyProvider` resolves from the account, then the device. Recognizers want a
 * regional tag (`es-MX`, not `es`), and the device knows which region the
 * person speaks, so a bare language borrows the region of the first device
 * locale in the same language before falling back to the tag itself.
 */
export function speechLocale(): string {
  const tag = i18n.locale || 'en-US';
  if (tag.includes('-')) return tag;
  const regional = getLocales().find((locale) => locale.languageCode === tag && locale.languageTag.includes('-'));
  return regional?.languageTag ?? tag;
}
