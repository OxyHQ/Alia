import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { env } from 'vscode';

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

// --- Token exchange: RFC 6749 §4.1.3 request / §5.1 response ---

const OXY_CLIENT_ID = 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';
const TOKEN_ENDPOINT = 'https://api.oxy.so/auth/oauth/token';
const CALLBACK_URI = 'vscode://oxy.alia-codea/auth-callback';

/** The `fetch` init the provider builds for the token request. */
interface RecordedInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RecordedRequest {
  url: string;
  init: RecordedInit;
}

/** What the stubbed token endpoint answers with. */
interface StubbedResponse {
  status: number;
  body: unknown;
  /** `false` makes `response.json()` reject, as a non-JSON body would. */
  json?: boolean;
}

interface SignInOutcome {
  session: vscode.AuthenticationSession | null;
  error: Error | null;
  requests: RecordedRequest[];
}

/**
 * A context whose SecretStorage starts EMPTY, so cold-start `initialize()`
 * restores nothing and the sign-in under test is the only thing that writes.
 */
function makeSignInContext(): { context: vscode.ExtensionContext; secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
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
  return { context: { secrets: secretStorage } as unknown as vscode.ExtensionContext, secrets };
}

/**
 * Drive one full browser sign-in: start the flow, read the `state` off the
 * authorization URL the provider opens, then answer the callback with a code.
 * Returns the resolved session (or the rejection) together with the recorded
 * token request, which is what the request-shape assertions read.
 */
async function runSignIn(
  provider: AliaAuthenticationProvider,
  response: StubbedResponse,
): Promise<SignInOutcome> {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RecordedInit) => {
    requests.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => {
        if (response.json === false) {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        }
        return response.body;
      },
    };
  });

  let openedUrl = '';
  env.openExternal = async (target: { toString(): string }) => {
    openedUrl = target.toString();
    return true;
  };

  const pending = provider.signInWithBrowser();
  // `signInWithBrowser` awaits `openExternal` before returning its promise, so
  // yield until the authorization URL has been captured.
  await Promise.resolve();
  await Promise.resolve();

  const state = new URL(openedUrl).searchParams.get('state');
  if (!state) {
    throw new Error(`expected a state parameter on the authorization URL: "${openedUrl}"`);
  }

  const callback = {
    path: '/auth-callback',
    query: `code=auth-code-1&state=${encodeURIComponent(state)}`,
  } as unknown as vscode.Uri;

  await provider.handleUri(callback);

  try {
    return { session: await pending, error: null, requests };
  } catch (err) {
    return { session: null, error: err as Error, requests };
  }
}

/** The flat RFC 6749 §5.1 document the token endpoint returns. */
function flatTokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'access-token-1',
    token_type: 'Bearer',
    expires_in: 900,
    session_id: 'session-1',
    deviceId: 'device-1',
    deviceSecret: 'device-secret-1',
    user: { id: 'user-1', username: 'natefromoxy', name: { displayName: 'Nate Isern' } },
    ...overrides,
  };
}

describe('AliaAuthenticationProvider token exchange', () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an RFC 6749 §4.1.3 form-encoded request, not camelCase JSON', async () => {
    const provider = new AliaAuthenticationProvider(makeSignInContext().context);
    const { session, requests } = await runSignIn(provider, {
      status: 200,
      body: flatTokenBody(),
    });

    expect(session).not.toBeNull();
    expect(requests).toHaveLength(1);

    const { url, init } = requests[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');

    // The body is form-encoded, so it is NOT parseable as JSON. This is the
    // assertion that fails if the request ever regresses to `JSON.stringify`.
    const body = init.body ?? '';
    expect(() => JSON.parse(body)).toThrow();

    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code-1');
    expect(params.get('redirect_uri')).toBe(CALLBACK_URI);
    expect(params.get('client_id')).toBe(OXY_CLIENT_ID);
    // The PKCE verifier is generated per sign-in; only its presence is fixed.
    expect(params.get('code_verifier')).toBeTruthy();

    // The retired camelCase parameter names must not appear under any encoding.
    expect(body).not.toContain('clientId');
    expect(body).not.toContain('redirectUri');
    expect(body).not.toContain('codeVerifier');

    provider.dispose();
  });

  it('reads the flat §5.1 response — every member at the top level', async () => {
    const { context, secrets } = makeSignInContext();
    const provider = new AliaAuthenticationProvider(context);
    const before = Date.now();
    const { session } = await runSignIn(provider, {
      status: 200,
      body: flatTokenBody(),
    });

    expect(session?.accessToken).toBe('access-token-1');
    expect(session?.account.id).toBe('user-1');
    // `getCurrentUser` is unavailable in tests, so the label falls back to the
    // username carried in the token response.
    expect(session?.account.label).toBe('natefromoxy');
    // `session_id` is read from the top level, not from a `data` wrapper.
    expect(session?.id).toBe('session-1');

    const sessions = await provider.getSessions();
    expect(sessions).toHaveLength(1);
    expect(provider.getOxyServices().getAccessToken()).toBe('access-token-1');

    // `expires_in` (seconds, top level) drives the persisted expiry.
    const raw = secrets.get(SESSION_KEY);
    if (!raw) {
      throw new Error('expected the sign-in to persist a session');
    }
    const persisted = JSON.parse(raw) as { expiresAt: string; refreshToken?: string };
    const expiresAt = Date.parse(persisted.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 900 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900 * 1000);
    // The token endpoint issues no refresh token; nothing may invent one.
    expect(persisted.refreshToken).toBeUndefined();

    provider.dispose();
  });

  it('falls back to name.displayName when the account has no username', async () => {
    const provider = new AliaAuthenticationProvider(makeSignInContext().context);
    const { session } = await runSignIn(provider, {
      status: 200,
      body: flatTokenBody({ user: { id: 'user-2', name: { displayName: 'Nate Isern' } } }),
    });

    expect(session?.account.label).toBe('Nate Isern');

    provider.dispose();
  });

  it('rejects a legacy `{ data: … }`-wrapped body instead of unwrapping it', async () => {
    const provider = new AliaAuthenticationProvider(makeSignInContext().context);
    const { session, error } = await runSignIn(provider, {
      status: 200,
      body: { data: flatTokenBody() },
    });

    // The old client guessed with `payload.data ?? payload`. The wrapper is no
    // longer a shape this client accepts.
    expect(session).toBeNull();
    expect(error?.message).toBe('OAuth token exchange returned no access token.');

    provider.dispose();
  });

  it('surfaces the RFC 6749 §5.2 error document', async () => {
    const provider = new AliaAuthenticationProvider(makeSignInContext().context);
    const { session, error } = await runSignIn(provider, {
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'The authorization code is invalid or has expired.',
      },
    });

    expect(session).toBeNull();
    expect(error?.message).toBe(
      'The authorization code is invalid or has expired. (invalid_grant)',
    );

    provider.dispose();
  });

  it('falls back to the HTTP status when the failure carries no §5.2 document', async () => {
    const provider = new AliaAuthenticationProvider(makeSignInContext().context);
    const { session, error } = await runSignIn(provider, {
      status: 502,
      body: null,
      json: false,
    });

    expect(session).toBeNull();
    expect(error?.message).toBe('OAuth token exchange failed (502).');

    provider.dispose();
  });

  it('rejects a grant that is not a bearer token', async () => {
    const provider = new AliaAuthenticationProvider(makeSignInContext().context);
    const { session, error } = await runSignIn(provider, {
      status: 200,
      body: flatTokenBody({ token_type: 'mac' }),
    });

    expect(session).toBeNull();
    expect(error?.message).toBe(
      'OAuth token exchange returned an unsupported token type (mac).',
    );

    provider.dispose();
  });
});
