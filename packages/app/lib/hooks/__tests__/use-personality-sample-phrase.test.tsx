import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which model the personality sample asks for.
 *
 * The hook sent the literal `kaana-lite`. That is a de-advertised compatibility
 * alias (ADR 0003): `GET /catalogue` does not list it and `GET /v1/models`
 * returns `[]`, so the one request in the app that named a model directly named
 * something the product no longer publishes — and named it in a place no
 * configuration could reach, so an operator repointing
 * `EXPO_PUBLIC_ALIA_DEFAULT_MODEL` repointed every request except this one.
 *
 * The assertion is on the OUTGOING body, which is normally the weaker of the
 * two things a request test can check — a payload assertion passes happily
 * while the server 400s every call. It is the right one HERE because the
 * property under change is entirely client-side: which identifier this app
 * chooses to name. Nothing about the response can distinguish `kaana-lite` from
 * `profile:v1`; both resolve and both stream. So the fetch is counted as well
 * as read, because "no alias was sent" is also what sending nothing looks like.
 */

// `lib/config.ts` and `lib/generate-api-url.ts` reach for the native runtime for
// the API host, which has nothing to do with the identifier under test. Only
// those two modules are stood in for; the hook itself is the real one.
vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web } }));
vi.mock('expo-constants', () => ({ default: { experienceUrl: undefined } }));

const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];

vi.mock('expo/fetch', () => ({
  fetch: vi.fn(async (url: string, init: { body: string }) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
    };
  }),
}));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({ oxyServices: { getAccessToken: () => 'test-token' } }),
}));

import { DEFAULT_MODEL_ID } from '@/lib/config';
import { usePersonalitySamplePhrase } from '../use-personality-sample-phrase';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function mountHook(): { fetchPhrase: (styleId: 'witty') => void } {
  const captured: { current: ReturnType<typeof usePersonalitySamplePhrase> | null } = {
    current: null,
  };
  function Probe() {
    captured.current = usePersonalitySamplePhrase();
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  if (captured.current === null) throw new Error('the hook did not run');
  return captured.current;
}

beforeEach(() => {
  fetchCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
});

describe('the personality sample names a model', () => {
  async function requestOneSample() {
    const { fetchPhrase } = mountHook();
    act(() => fetchPhrase('witty'));
    // The hook debounces by 300ms before it fetches at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }

  it('sends exactly one request, so the assertions below are about a real body', async () => {
    // The positive control. Every assertion in this file is over `fetchCalls[0]`
    // and would be vacuously satisfiable by a hook that never fetched — which is
    // also what a broken debounce, a swallowed error or an unmounted probe look
    // like.
    await requestOneSample();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.messages).toBeInstanceOf(Array);
  });

  it("asks for the app's configured default, not a hardcoded identifier", async () => {
    await requestOneSample();

    // Compared against the exported constant rather than against `'profile:v1'`:
    // the point is that this request follows the app's default wherever it is
    // pointed, including through `EXPO_PUBLIC_ALIA_DEFAULT_MODEL`. Asserting the
    // literal would go green on a second hardcoded copy that merely happened to
    // agree today.
    expect(fetchCalls[0].body.model).toBe(DEFAULT_MODEL_ID);
  });

  it('never names a compatibility alias', async () => {
    await requestOneSample();

    /**
     * The half that survives the default moving. `DEFAULT_MODEL_ID` is
     * configurable, so the assertion above is satisfied by any value it is set
     * to — including an `alia-*` one. This says the request names a routing
     * profile, which is the vocabulary the catalogue actually publishes.
     */
    expect(String(fetchCalls[0].body.model).startsWith('alia-')).toBe(false);
    expect(String(fetchCalls[0].body.model).startsWith('profile:')).toBe(true);
  });
});
