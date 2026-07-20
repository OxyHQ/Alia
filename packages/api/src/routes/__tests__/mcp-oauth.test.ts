// packages/api/src/routes/__tests__/mcp-oauth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// INTEGRATIONS_URL/SECRET are captured into module-level consts at import time,
// so they must be present BEFORE mcp.ts is imported. vi.hoisted runs first.
vi.hoisted(() => {
  process.env.INTEGRATIONS_URL = 'http://integrations.test';
  process.env.INTEGRATIONS_SECRET = 'integrations-secret';
  process.env.APP_URL = 'http://app.test';
});

vi.mock('../../models/mcp-server.js', () => {
  const McpServer = vi.fn();
  (McpServer as unknown as { findOne: unknown }).findOne = vi.fn();
  return { McpServer };
});

vi.mock('../../models/mcp-oauth-state.js', () => ({
  McpOAuthState: { findOne: vi.fn(), deleteOne: vi.fn(), create: vi.fn() },
  MCP_OAUTH_STATE_TTL_SECONDS: 600,
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../lib/mcp-registry.js', () => ({
  MCP_REGISTRY: [
    {
      id: 'github',
      name: 'GitHub',
      description: 'GitHub connector',
      icon: 'github',
      transport: 'streamable-http',
      url: 'https://mcp.github.test',
      requiresOAuth: true,
      category: 'development',
    },
  ],
}));

import { McpServer } from '../../models/mcp-server.js';
import { McpOAuthState } from '../../models/mcp-oauth-state.js';
import router from '../mcp.js';

const mockMcpServer = McpServer as unknown as ReturnType<typeof vi.fn> & {
  findOne: ReturnType<typeof vi.fn>;
};
const mockMcpOAuthState = McpOAuthState as unknown as Record<string, ReturnType<typeof vi.fn>>;

// Two valid 24-hex ObjectId strings — mcp.ts wraps req.userId in
// `new mongoose.Types.ObjectId(...)`, which throws on non-hex ids.
const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';

function getRouteHandler(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route handler found for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  // Last handler in the stack is the real route handler (earlier entries are
  // middleware such as authenticateToken, which we bypass by calling directly).
  return stack[stack.length - 1].handle as (req: any, res: any) => Promise<void> | void;
}

function makeMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  res.redirect = vi.fn((url: string) => { res.redirectUrl = url; return res; });
  res.sendStatus = vi.fn((code: number) => { res.statusCode = code; return res; });
  return res;
}

describe('mcp.ts — OAuth CSRF binding + idempotent install', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  describe('POST /oauth/complete — CSRF binding', () => {
    it('responds 403 and does NOT exchange when state was issued to a different user', async () => {
      mockMcpOAuthState.findOne.mockResolvedValue({
        _id: 'state-doc-1',
        state: 'the-state',
        oxyUserId: USER_B, // issued to someone else
        serverId: 'srv-1',
        createdAt: new Date(),
      });

      const handler = getRouteHandler('post', '/oauth/complete');
      const req: any = { userId: USER_A, body: { state: 'the-state', code: 'the-code' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
      // State must NOT be consumed on a rejected CSRF attempt.
      expect(mockMcpOAuthState.deleteOne).not.toHaveBeenCalled();
    });

    it('consumes the state and proxies to integrations when state belongs to the caller', async () => {
      mockMcpOAuthState.findOne.mockResolvedValue({
        _id: 'state-doc-1',
        state: 'the-state',
        oxyUserId: USER_A, // belongs to the caller
        serverId: 'srv-1',
        createdAt: new Date(),
      });
      mockMcpOAuthState.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const server: any = {
        _id: 'srv-1',
        config: {},
        status: 'installed',
        tools: [],
        resources: [],
        save: vi.fn().mockResolvedValue(undefined),
      };
      mockMcpServer.findOne.mockResolvedValue(server);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, tools: [{ name: 't' }], resources: [] }),
      });

      const handler = getRouteHandler('post', '/oauth/complete');
      const req: any = { userId: USER_A, body: { state: 'the-state', code: 'the-code' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(mockMcpOAuthState.deleteOne).toHaveBeenCalledWith({ _id: 'state-doc-1' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ server });
      expect(server.status).toBe('running');
      expect(server.config.requiresOAuth).toBe(true);
    });
  });

  describe('GET /oauth/callback — public, does not link', () => {
    it('redirects with mcp_oauth_state + mcp_oauth_code and never exchanges', async () => {
      mockMcpOAuthState.findOne.mockResolvedValue({
        _id: 'state-doc-1',
        state: 'the-state',
        oxyUserId: USER_A,
        serverId: 'srv-1',
        createdAt: new Date(), // unexpired
      });

      const handler = getRouteHandler('get', '/oauth/callback');
      const req: any = { query: { code: 'the-code', state: 'the-state' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      expect(res.redirectUrl).toContain('/settings/connectors?');
      expect(res.redirectUrl).toContain('mcp_oauth_state=the-state');
      expect(res.redirectUrl).toContain('mcp_oauth_code=the-code');
      // The public callback never exchanges the code.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('redirects with error= when code/state are missing', async () => {
      const handler = getRouteHandler('get', '/oauth/callback');
      const req: any = { query: {} };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      expect(res.redirectUrl).toContain('error=');
      expect(mockMcpOAuthState.findOne).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('POST /install — idempotency on duplicate key', () => {
    it('returns 200 with the existing server on a duplicate registry install', async () => {
      // Regular function so `new McpServer(...)` can construct it (arrow fns throw).
      mockMcpServer.mockImplementation(function (this: any, data: any) {
        Object.assign(this, data);
        this.save = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
      });

      const existing = { _id: 'existing-1', name: 'github', displayName: 'GitHub' };
      mockMcpServer.findOne.mockResolvedValue(existing);

      const handler = getRouteHandler('post', '/install');
      const req: any = { userId: USER_A, body: { registryId: 'github' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ server: existing });
      expect(mockMcpServer.findOne).toHaveBeenCalledWith({
        oxyUserId: expect.anything(),
        name: 'github',
      });
    });

    it('returns 409 on a duplicate CUSTOM install (no registryId)', async () => {
      mockMcpServer.mockImplementation(function (this: any, data: any) {
        Object.assign(this, data);
        this.save = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
      });

      const handler = getRouteHandler('post', '/install');
      const req: any = {
        userId: USER_A,
        body: {
          name: 'my-custom',
          displayName: 'My Custom',
          transport: 'streamable-http',
        },
      };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(409);
      // No existing-server lookup for a custom install.
      expect(mockMcpServer.findOne).not.toHaveBeenCalled();
    });
  });
});
