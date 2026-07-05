import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';

// The rotation call is the thing under test: it MUST run exactly once per real
// expiry even under a stampede of concurrent callers. Hoisted so the module
// mock factory below can reference it.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('@oxyhq/core', () => {
  // Only the OxyServices surface `authProvider.ts` uses is implemented.
  class OxyServices {
    private access: string | null = null;
    setTokens(access: string): void {
      this.access = access;
    }
    clearTokens(): void {
      this.access = null;
    }
    getAccessToken(): string | null {
      return this.access;
    }
    getAccessTokenExpiry(): number | null {
      // Force `isPlantedTokenFresh` onto the persisted ISO-expiry fallback so
      // tests drive freshness purely through the stored session.
      return null;
    }
    async getCurrentUser(): Promise<never> {
      throw new Error('network disabled in tests');
    }
    refreshWithToken(
      refreshToken: string,
    ): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
      return refreshMock(refreshToken);
    }
  }
  return { OxyServices };
});

import { AliaAuthenticationProvider } from '../authProvider';

const SESSION_KEY = 'alia.session.v1';
const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastExpiry = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

// A fresh planted token so cold-start `initialize()` restores from storage
// without rotating — this isolates each test from construction-time refresh.
function freshSession(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: futureExpiry(),
    userId: 'user-1',
    username: 'Test User',
    ...overrides,
  };
}

function makeContext(session: Record<string, unknown>) {
  const secrets = new Map<string, string>([[SESSION_KEY, JSON.stringify(session)]]);
  const secretStorage = {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => {
      secrets.set(key, value);
    },
    delete: async (key: string) => {
      secrets.delete(key);
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
  const context = { secrets: secretStorage } as unknown as vscode.ExtensionContext;
  // `storage` is the live SecretStorage double (same reference the provider
  // holds), so a test can flip `storage.get` to reject and simulate a locked
  // keychain mid-session.
  return { context, secrets, storage: secretStorage };
}

function readPersisted(secrets: Map<string, string>): { accessToken: string; refreshToken: string } {
  const raw = secrets.get(SESSION_KEY);
  if (!raw) {
    throw new Error('expected a persisted session');
  }
  return JSON.parse(raw) as { accessToken: string; refreshToken: string };
}

describe('AliaAuthenticationProvider refresh single-flight', () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });

  it('coalesces concurrent refreshToken() calls into ONE rotation', async () => {
    refreshMock.mockImplementation(async () => {
      // A real round-trip so the second caller arrives while the first is
      // in-flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: futureExpiry() };
    });

    const { context, secrets } = makeContext(freshSession());
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions(); // awaits cold-start initialize()
    expect(refreshMock).not.toHaveBeenCalled(); // fresh token → no startup refresh

    const [a, b] = await Promise.all([provider.refreshToken(), provider.refreshToken()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    // Core assertion: the rotation ran exactly once, against the ORIGINAL
    // refresh token — never a second rotation of an already-rotated token (which
    // is what trips server-side reuse-detection and revokes the family).
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith('refresh-1');
    // Both callers observe the same rotated token pair.
    expect(provider.getOxyServices().getAccessToken()).toBe('access-2');
    expect(readPersisted(secrets).refreshToken).toBe('refresh-2');

    provider.dispose();
  });

  it('coalesces a concurrent getAccessToken() stampede into one rotation', async () => {
    refreshMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: futureExpiry() };
    });

    const { context, secrets } = makeContext(freshSession());
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions();
    expect(refreshMock).not.toHaveBeenCalled();

    // Age the planted token so the next reads must rotate.
    secrets.set(SESSION_KEY, JSON.stringify(freshSession({ expiresAt: pastExpiry() })));

    const [t1, t2] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(t1).toBe('access-2');
    expect(t2).toBe('access-2');
    expect(t1).toBe(t2);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith('refresh-1');

    provider.dispose();
  });

  it('starts a fresh rotation after the previous one settles', async () => {
    // Each rotation advances the family: refresh-N → refresh-(N+1).
    refreshMock.mockImplementation(async (rt: string) => {
      const generation = Number(rt.split('-')[1]);
      return {
        accessToken: `access-${generation + 1}`,
        refreshToken: `refresh-${generation + 1}`,
        expiresAt: futureExpiry(),
      };
    });

    const { context, secrets } = makeContext(freshSession());
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions();

    await provider.refreshToken(); // refresh-1 → refresh-2
    await provider.refreshToken(); // refresh-2 → refresh-3

    // The single-flight guard is cleared in `finally`, so a genuinely later
    // refresh rotates again instead of returning the stale shared promise.
    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(refreshMock).toHaveBeenNthCalledWith(1, 'refresh-1');
    expect(refreshMock).toHaveBeenNthCalledWith(2, 'refresh-2');
    expect(readPersisted(secrets).refreshToken).toBe('refresh-3');

    provider.dispose();
  });

  it('clears the in-flight guard on failure so a later refresh can retry', async () => {
    refreshMock
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: futureExpiry(),
      });

    const { context } = makeContext(freshSession());
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions();

    const first = await provider.refreshToken();
    expect(first).toBe(false);

    const second = await provider.refreshToken();
    expect(second).toBe(true);

    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(provider.getOxyServices().getAccessToken()).toBe('access-2');

    provider.dispose();
  });

  it('resolves to false (never rejects) when the storage read fails, for all awaiters', async () => {
    const { context, storage } = makeContext(freshSession());
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions(); // cold-start restore while storage still works

    // Simulate a locked keychain: the read now rejects. This happens BEFORE
    // rotateRefreshToken's own try/catch, so without the single-flight
    // `.catch(() => false)` the shared promise would reject and propagate as an
    // unhandled rejection to callers that don't catch.
    storage.get = async () => {
      throw new Error('keychain locked');
    };

    const results = await Promise.all([
      provider.refreshToken(),
      provider.refreshToken(),
    ]);

    // Both concurrent awaiters get a clean `false` — no throw, no rotation.
    expect(results).toEqual([false, false]);
    expect(refreshMock).not.toHaveBeenCalled();

    // The guard cleared, so a later refresh (storage recovered) can still run.
    storage.get = async () => JSON.stringify(freshSession());
    refreshMock.mockResolvedValueOnce({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: futureExpiry(),
    });
    expect(await provider.refreshToken()).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);

    provider.dispose();
  });
});
