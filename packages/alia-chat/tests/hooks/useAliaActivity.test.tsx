import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: true, oxyServices: { session: { accessToken: 'tok' } } },
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => mocks.auth,
}));
vi.mock('../../src/lib/activity-socket', () => ({
  acquireActivitySocket: (...args: unknown[]) => {
    mocks.acquire(...args);
    return mocks.release;
  },
}));

import { useAliaActivity } from '../../src/hooks/useAliaActivity';
import { useAliaActivityStore } from '../../src/lib/activity-store';

let seen: string[] = [];
function Probe() {
  seen.push(useAliaActivity({ apiUrl: 'https://api.test' }));
  return null;
}

describe('useAliaActivity', () => {
  beforeEach(() => {
    seen = [];
    mocks.acquire.mockClear();
    mocks.release.mockClear();
    mocks.auth.isAuthenticated = true;
    useAliaActivityStore.setState({ local: {}, remote: {} });
  });

  it('listens while signed in, with the live session token, and releases on unmount', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    const [url, getToken] = mocks.acquire.mock.calls[0] as [string, () => string | null];
    expect(url).toBe('https://api.test');
    expect(getToken()).toBe('tok');

    act(() => renderer.unmount());
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('opens no connection when signed out, and closes it on sign-out', () => {
    mocks.auth.isAuthenticated = false;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(mocks.acquire).not.toHaveBeenCalled();

    mocks.auth.isAuthenticated = true;
    act(() => renderer.update(<Probe />));
    expect(mocks.acquire).toHaveBeenCalledTimes(1);

    mocks.auth.isAuthenticated = false;
    act(() => renderer.update(<Probe />));
    expect(mocks.release).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('follows the store, whichever source moved it', () => {
    act(() => {
      TestRenderer.create(<Probe />);
    });
    expect(seen.at(-1)).toBe('idle');
    act(() => useAliaActivityStore.getState().setLocal('sheet', 'writing'));
    expect(seen.at(-1)).toBe('writing');
    act(() => useAliaActivityStore.getState().setRemote('s', 'working'));
    expect(seen.at(-1)).toBe('working');
  });
});
