import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether `t` holds its identity, and whether it lets go of it when it must.
 *
 * Both halves matter and they pull in opposite directions, which is the whole
 * reason this file exists.
 *
 * A NEW `t` on every render is what closed the agent editor's autosave loop: a
 * `useCallback` keyed on `[t]` starts a timer that writes and calls `setSaving`,
 * an effect depends on that callback, and the render the write causes hands
 * everything a new identity — one write per second, indefinitely. Measured in
 * Chromium against `main`: one keystroke, thirteen writes in fifteen seconds.
 *
 * A `t` that NEVER changes is the wrong fix, and it looks correct: `i18n.t`
 * reads the locale when it is called, so text rendered directly still comes out
 * in the new language. What breaks is anything that memoised a translated string
 * on `[t]` — it never recomputes, and the old language stays on screen. That
 * case is the second test, and it is what `[]` fails.
 */

const state = { locale: 'en-US' };
const listeners = new Set<() => void>();

vi.mock('@/lib/stores/i18n-store', () => ({
  useI18nStore: (select: (s: { locale: string; setLocale: (l: string) => void }) => unknown) => {
    const React_ = require('react') as typeof React;
    const [, force] = React_.useReducer((n: number) => n + 1, 0);
    React_.useEffect(() => {
      listeners.add(force);
      return () => {
        listeners.delete(force);
      };
    }, []);
    return select({ locale: state.locale, setLocale: () => {} });
  },
}));

vi.mock('@/lib/i18n', () => ({
  default: {
    // Stands in for the real catalogue: one key, two languages, read at CALL
    // time exactly as `i18n.t` reads `i18n.locale`.
    t: (key: string) => (state.locale.startsWith('es') ? `es:${key}` : `en:${key}`),
  },
}));

import { useTranslation } from '../use-translation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setLocale(locale: string) {
  act(() => {
    state.locale = locale;
    for (const listener of listeners) listener();
  });
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  state.locale = 'en-US';
});

describe('the translate function', () => {
  it('keeps one identity across renders that do not change the language', () => {
    // The property whose absence is the loop. A component that re-renders for
    // its OWN reasons — a save finishing, a spinner starting — must not be
    // handed a new `t`, or everything keyed on it is rebuilt with it.
    const seen: Array<(key: string) => string> = [];

    function Probe({ tick }: { tick: number }) {
      const { t } = useTranslation();
      seen.push(t);
      return <>{String(tick)}</>;
    }

    act(() => {
      renderer = create(<Probe tick={0} />);
    });
    for (let tick = 1; tick <= 5; tick++) {
      act(() => renderer?.update(<Probe tick={tick} />));
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(1);
  });

  it('lets go of it when the language changes, so a memo keyed on it recomputes', () => {
    // The control on the fix above: `[]` also passes the first test, also
    // renders the right words directly, and silently strands every consumer
    // that computed a string once.
    let recomputed = 0;

    function Probe() {
      const { t } = useTranslation();
      const greeting = React.useMemo(() => {
        recomputed += 1;
        return t('greeting');
      }, [t]);
      return <>{greeting}</>;
    }

    act(() => {
      renderer = create(<Probe />);
    });
    expect(renderer?.toJSON()).toBe('en:greeting');
    expect(recomputed).toBe(1);

    setLocale('es-ES');

    expect(renderer?.toJSON()).toBe('es:greeting');
    expect(recomputed).toBe(2);
  });

  it('reports the locale it is memoised against', () => {
    function Probe() {
      const { locale } = useTranslation();
      return <>{locale}</>;
    }

    act(() => {
      renderer = create(<Probe />);
    });
    expect(renderer?.toJSON()).toBe('en-US');

    setLocale('es-ES');

    expect(renderer?.toJSON()).toBe('es-ES');
  });
});
