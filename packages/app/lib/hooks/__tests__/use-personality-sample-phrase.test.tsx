import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which model the personality sample asks for: none.
 *
 * The app ships no model identifier. A request that names none is answered by
 * the server's default model, so the assertion is on the OUTGOING body — the
 * property under test is entirely client-side: which identifier this app
 * chooses to name.
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

vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ oxyServices: { getAccessToken: () => 'test-token' } }),
}));

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

  it('names no model, so the server default answers', async () => {
    await requestOneSample();

    // The app ships no model identifier: a request that names none is
    // answered by the server's default model.
    expect(fetchCalls[0].body).not.toHaveProperty('model');
  });
});
