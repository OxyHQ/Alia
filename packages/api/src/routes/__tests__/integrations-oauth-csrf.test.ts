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

vi.mock('../../models/integration.js', () => {
  const Integration: any = vi.fn();
  Integration.findById = vi.fn();
  Integration.findOne = vi.fn();
  Integration.find = vi.fn();
  Integration.findOneAndDelete = vi.fn();
  return { Integration };
});

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import mongoose from 'mongoose';
import { Integration } from '../../models/integration.js';
import router from '../integrations-oauth.js';

// integrations-oauth.ts registers the OAuthState model inline via
// mongoose.model('OAuthState', schema) at import time. Retrieve that compiled
// model and spy on its statics so we control the state store without a DB.
const OAuthState = mongoose.model('OAuthState');
const mockIntegration = Integration as unknown as ReturnType<typeof vi.fn> & {
  findById: ReturnType<typeof vi.fn>;
};

// google-calendar is a real INTEGRATION_REGISTRY entry using the GOOGLE_OAUTH_*
// env vars set above.
const SERVICE = 'google-calendar';
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
  let findOneSpy: ReturnType<typeof vi.spyOn>;
  let findOneAndDeleteSpy: ReturnType<typeof vi.spyOn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    findOneSpy = vi.spyOn(OAuthState, 'findOne');
    findOneAndDeleteSpy = vi.spyOn(OAuthState, 'findOneAndDelete');
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('responds 403 and does NOT exchange when state was issued to a different user', async () => {
    findOneSpy.mockResolvedValue({
      _id: 'state-token',
      service: SERVICE,
      userId: USER_B, // issued to someone else
      expiresAt: new Date(Date.now() + 60_000),
    } as any);

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
    expect(findOneAndDeleteSpy).not.toHaveBeenCalled();
  });

  it('consumes the state and exchanges the code when state belongs to the caller', async () => {
    findOneSpy.mockResolvedValue({
      _id: 'state-token',
      service: SERVICE,
      userId: USER_A, // belongs to the caller
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    findOneAndDeleteSpy.mockResolvedValue({
      _id: 'state-token',
      service: SERVICE,
      userId: USER_A,
    } as any);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    });

    const saved = { _id: 'int-1', service: SERVICE, status: 'active' };
    // Regular function so `new Integration(...)` can construct it (arrow fns throw).
    mockIntegration.mockImplementation(function (this: any, data: any) {
      Object.assign(this, data);
      this._id = 'int-1';
      this.save = vi.fn().mockResolvedValue(undefined);
    });
    // Return-the-safe-integration lookup at the end of the handler.
    mockIntegration.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue(saved),
    });

    const handler = getRouteHandler('post', '/:service/complete');
    const req: any = {
      userId: USER_A,
      params: { service: SERVICE },
      body: { state: 'state-token', code: 'the-code' },
    };
    const res = makeMockRes();

    await handler(req, res);

    expect(findOneAndDeleteSpy).toHaveBeenCalledWith({ _id: 'state-token' });
    // The token exchange fired (a best-effort profile fetch may follow — assert
    // the first call was the token endpoint rather than an exact call count).
    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ integration: saved });
  });
});
