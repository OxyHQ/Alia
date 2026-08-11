// packages/api/src/routes/__tests__/integrations-oauth-csrf.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  // getOAuthCredentials reads these per-service env vars; without them the
  // handler short-circuits with 503 before the token exchange.
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
  process.env.API_BASE_URL = 'http://api.test';
  process.env.APP_URL = 'http://app.test';
});

vi.mock('../../db/integrations/integrationRepository.js', () => ({
  createIntegration: vi.fn(),
  deleteIntegrationForUser: vi.fn(),
  findIntegrationForUser: vi.fn(),
  listIntegrationsForUser: vi.fn(),
}));

// `OAUTH_STATE_TTL_MS` is a real export the route computes an expiry from, so it
// is kept rather than stubbed — a mocked constant would let a wrong deadline
// pass unnoticed.
vi.mock('../../db/integrations/oauthStateRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../db/integrations/oauthStateRepository.js')
  >('../../db/integrations/oauthStateRepository.js');
  return {
    OAUTH_STATE_TTL_MS: actual.OAUTH_STATE_TTL_MS,
    createOAuthState: vi.fn(),
    findLiveOAuthState: vi.fn(),
    consumeOAuthState: vi.fn(),
  };
});

// The handle is never used — every repository call is mocked — but `getDb()`
// throws when Postgres is not connected.
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { createIntegration } from '../../db/integrations/integrationRepository.js';
import {
  consumeOAuthState,
  findLiveOAuthState,
} from '../../db/integrations/oauthStateRepository.js';
import router from '../integrations-oauth.js';

const mockCreateIntegration = vi.mocked(createIntegration);
const mockFindState = vi.mocked(findLiveOAuthState);
const mockConsumeState = vi.mocked(consumeOAuthState);

// google-calendar is a real INTEGRATION_REGISTRY entry using the GOOGLE_OAUTH_*
// env vars set above.
const SERVICE = 'google-calendar';
/**
 * Two distinct user ids. They were 24-hex ObjectId strings because the route
 * wrapped `req.userId` in `new mongoose.Types.ObjectId(...)`; `oxy_user_id` is
 * `text` now and they need only differ.
 */
const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';

function getRouteHandler(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route handler found for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any) => Promise<void> | void;
}

function makeMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  res.redirect = vi.fn((url: string) => { res.redirectUrl = url; return res; });
  return res;
}

describe('integrations-oauth.ts — POST /:service/complete CSRF binding', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('responds 403 and does NOT exchange when state was issued to a different user', async () => {
    mockFindState.mockResolvedValue({
      id: 'state-token',
      service: SERVICE,
      userId: USER_B, // issued to someone else
      expiresAt: new Date(Date.now() + 60_000),
    });

    const handler = getRouteHandler('post', '/:service/complete');
    const req: any = {
      userId: USER_A,
      params: { service: SERVICE },
      body: { state: 'state-token', code: 'the-code' },
    };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    // State must NOT be consumed on a rejected CSRF attempt.
    expect(mockConsumeState).not.toHaveBeenCalled();
    // And no integration is created under EITHER account.
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });

  it('consumes the state and exchanges the code when state belongs to the caller', async () => {
    mockFindState.mockResolvedValue({
      id: 'state-token',
      service: SERVICE,
      userId: USER_A, // belongs to the caller
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockConsumeState.mockResolvedValue(true);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    });

    const saved = {
      _id: 'int-1',
      id: 'int-1',
      service: SERVICE,
      displayName: 'Google Calendar',
      accountId: null,
      accountName: null,
      avatarUrl: null,
      status: 'active' as const,
      enabled: true,
      metadata: {},
      connectedAt: new Date(),
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockCreateIntegration.mockResolvedValue(saved);

    const handler = getRouteHandler('post', '/:service/complete');
    const req: any = {
      userId: USER_A,
      params: { service: SERVICE },
      body: { state: 'state-token', code: 'the-code' },
    };
    const res = makeMockRes();

    await handler(req, res);

    expect(mockConsumeState).toHaveBeenCalledWith(expect.anything(), 'state-token');
    // The token exchange fired (a best-effort profile fetch may follow — assert
    // the first call was the token endpoint rather than an exact call count).
    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ integration: saved });

    // The integration is bound to the AUTHENTICATED caller, never to the
    // identity carried by the state — which is the CSRF fix, and is worth
    // asserting on the write now that there is no document to inspect.
    expect(mockCreateIntegration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ oxyUserId: USER_A, service: SERVICE, accessToken: 'at' }),
    );
  });

  it('refuses a state that names a DIFFERENT service, with the same reason code', async () => {
    /**
     * Three conditions — unknown token, wrong service, expired — all answered
     * `Invalid or expired state` in the source and still do, because they are
     * one predicate in the repository. That sameness is the point: a client must
     * not be able to vary one input at a time and read out which part failed.
     */
    mockFindState.mockResolvedValue(null);

    const handler = getRouteHandler('post', '/:service/complete');
    const req: any = {
      userId: USER_A,
      params: { service: SERVICE },
      body: { state: 'state-for-another-service', code: 'the-code' },
    };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid or expired state' });
    expect(mockFetch).not.toHaveBeenCalled();
    // The route asked the repository for THIS service, not for the token alone.
    expect(mockFindState).toHaveBeenCalledWith(
      expect.anything(),
      'state-for-another-service',
      SERVICE,
    );
  });

  it('refuses when the state was already consumed between the load and the delete', async () => {
    // The replay/race guard. The load succeeds, the atomic delete loses, and the
    // exchange must not happen.
    mockFindState.mockResolvedValue({
      id: 'state-token',
      service: SERVICE,
      userId: USER_A,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockConsumeState.mockResolvedValue(false);

    const handler = getRouteHandler('post', '/:service/complete');
    const req: any = {
      userId: USER_A,
      params: { service: SERVICE },
      body: { state: 'state-token', code: 'the-code' },
    };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateIntegration).not.toHaveBeenCalled();
  });
});
