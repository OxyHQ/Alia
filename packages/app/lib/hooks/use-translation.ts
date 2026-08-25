import { useCallback } from 'react';
import i18n from '@/lib/i18n';
import { useI18nStore } from '@/lib/stores/i18n-store';

/**
 * Translations, from the store so a locale change reaches every component.
 *
 * ## `t` is MEMOISED, and that is load-bearing rather than tidy
 *
 * It used to be declared inline in this body, so every render handed back a new
 * function. Twenty-three hooks across `packages/app` list `t` in a dependency
 * array; for most of them a new identity per render only costs the memoisation
 * they were asking for, silently. For one it did much worse.
 *
 * The agent editor's autosave is a `useCallback` that starts a one-second timer
 * which writes and calls `setSaving`, called from an effect that depends on that
 * callback. With `t` in the chain the cycle closed on itself: the save finishes,
 * `setSaving` renders, `t` is new, the callback is new, the effect re-runs, a
 * new timer is scheduled, it fires, `setSaving` renders — one write per second,
 * for as long as the screen stayed open. Measured on `main`: a single keystroke
 * produced thirteen writes in fifteen seconds.
 *
 * ## Keyed on `locale`, and NOT on `[]`
 *
 * `[]` would make it stable forever and still return the right string, because
 * `i18n.t` reads `i18n.locale` when it is CALLED. What it would break is every
 * consumer that keys a `useMemo` on `[t]`: their memo would never recompute, so
 * a language change would leave already-computed text in the old language. The
 * suite has that case, and it is red under `[]`.
 */
export function useTranslation() {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);

  /**
   * The parameter type is left exactly as it was. Narrowing it to i18n-js's own
   * `TranslateOptions` fails three existing call sites that pass
   * `{ count: totalCredits.toLocaleString() }` — a formatted STRING where that
   * type declares a number. It works at runtime, because those keys interpolate
   * rather than pluralise, but it is a real looseness and tightening it means
   * changing what those three lines render. Not under a fix for a write loop.
   */
  const t = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (key: string, params?: Record<string, any>) => i18n.t(key, params),
    // The identity has to change when the language does, and only then.
    [locale],
  );

  return { t, locale, changeLocale: setLocale };
}
