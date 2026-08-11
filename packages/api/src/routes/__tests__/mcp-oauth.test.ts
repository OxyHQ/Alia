// packages/api/src/routes/__tests__/mcp-oauth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// INTEGRATIONS_URL/SECRET are captured into module-level consts at import time,
// so they must be present BEFORE mcp.ts is imported. vi.hoisted runs first.
vi.hoisted(() => {
  process.env.INTEGRATIONS_URL = 'http://integrations.test';
  process.env.INTEGRATIONS_SECRET = 'integrations-secret';
  process.env.APP_URL = 'http://app.test';
});

vi.mock('../../db/integrations/mcpServerRepository.js', async () => {
  // `serializeMcpServer` and `toMcpServerConfig` are PURE row transforms, and
  // they are the seam that keeps the wire shape (`_id`, a nested `config`)
  // apart from the flat columns. Mocking them away would leave the assertions
  // below unable to notice a broken serializer, so the real ones are kept and
  // only the query functions replaced.
  const actual = await vi.importActual<
    typeof import('../../db/integrations/mcpServerRepository.js')
  >('../../db/integrations/mcpServerRepository.js');
  return {
    ...actual,
    findMcpServerForUser: vi.fn(),
    findMcpServerByName: vi.fn(),
    listMcpServersForUser: vi.fn(),
    installMcpServer: vi.fn(),
    deleteMcpServerForUser: vi.fn(),
    updateMcpServer: vi.fn(),
    setMcpServerStatus: vi.fn(),
  };
});

vi.mock('../../db/integrations/mcpOAuthStateRepository.js', () => ({
  createMcpOAuthState: vi.fn(),
  findLiveMcpOAuthState: vi.fn(),
  deleteMcpOAuthState: vi.fn(),
  deleteMcpOAuthStateByToken: vi.fn(),
}));

// The handle is never used — every repository call is mocked — but `getDb()`
// throws when Postgres is not connected, which is correct production behaviour
// and would fail these unit tests for the wrong reason.
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('@oxyhq/core/server', () => ({
  createOxyAuthMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  createOptionalOxyAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
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

import {
  deleteMcpServerForUser,
  findMcpServerByName,
  findMcpServerForUser,
  installMcpServer,
  setMcpServerStatus,
  type McpServerRow,
} from '../../db/integrations/mcpServerRepository.js';
import {
  createMcpOAuthState,
  deleteMcpOAuthState,
  deleteMcpOAuthStateByToken,
  findLiveMcpOAuthState,
} from '../../db/integrations/mcpOAuthStateRepository.js';
import router from '../mcp.js';

const mockFindServer = vi.mocked(findMcpServerForUser);
const mockFindByName = vi.mocked(findMcpServerByName);
const mockInstall = vi.mocked(installMcpServer);
const mockSetStatus = vi.mocked(setMcpServerStatus);
const mockDeleteServer = vi.mocked(deleteMcpServerForUser);
const mockCreateState = vi.mocked(createMcpOAuthState);
const mockFindState = vi.mocked(findLiveMcpOAuthState);
const mockDeleteState = vi.mocked(deleteMcpOAuthState);
const mockDeleteStateByToken = vi.mocked(deleteMcpOAuthStateByToken);

/**
 * Two distinct user ids. They were 24-hex ObjectId strings because the route
 * wrapped `req.userId` in `new mongoose.Types.ObjectId(...)`, which threw on
 * anything else. `oxy_user_id` is `text` now and the ids need only differ —
 * kept in the old shape so the fixtures stay recognisable, not because the code
 * still requires it.
 */
const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';

/** A stored connector row, with only the fields a given test cares about set. */
function serverRow(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: 'srv-1',
    oxyUserId: USER_A,
    name: 'github',
    displayName: 'GitHub',
    description: null,
    icon: null,
    source: 'registry',
    registryId: 'github',
    transport: 'streamable-http',
    runtime: 'server',
    configCommand: null,
    configArgs: null,
    configUrl: 'https://mcp.github.test',
    configHeaders: null,
    configEnv: null,
    configRequiresOauth: true,
    status: 'installed',
    statusMessage: null,
    tools: [],
    resources: null,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function getRouteHandler(method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string) {
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
      mockFindState.mockResolvedValue({
        id: 'state-row-1',
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
      expect(mockDeleteState).not.toHaveBeenCalled();
    });

    it('consumes the state and proxies to integrations when state belongs to the caller', async () => {
      mockFindState.mockResolvedValue({
        id: 'state-row-1',
        oxyUserId: USER_A, // belongs to the caller
        serverId: 'srv-1',
        createdAt: new Date(),
      });
      mockFindServer.mockResolvedValue(serverRow());
      mockSetStatus.mockResolvedValue(
        serverRow({ status: 'running', configRequiresOauth: true, tools: [] }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, tools: [{ name: 't' }], resources: [] }),
      });

      const handler = getRouteHandler('post', '/oauth/complete');
      const req: any = { userId: USER_A, body: { state: 'the-state', code: 'the-code' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(mockDeleteState).toHaveBeenCalledWith(expect.anything(), 'state-row-1');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);

      // The durable OAuth mark, which a later `/:id/start` reads to reattach the
      // SDK OAuthClientProvider. Asserted on the WRITE rather than on a local
      // object, because there is no document to mutate any more.
      expect(mockSetStatus).toHaveBeenCalledWith(expect.anything(), 'srv-1', USER_A, {
        status: 'running',
        requiresOAuth: true,
        tools: [{ name: 't' }],
        resources: [],
      });

      // The response still carries `_id` and a NESTED `config`, which the
      // shipped mobile build reads. The real serializer produces both.
      expect(res.body.server._id).toBe('srv-1');
      expect(res.body.server.config).toEqual({
        url: 'https://mcp.github.test',
        requiresOAuth: true,
      });
    });
  });

  describe('POST /:id/oauth/start — authorization URL contract', () => {
    it('returns the authorization URL from integrations and creates state', async () => {
      mockFindServer.mockResolvedValue(serverRow({ runtime: 'server', transport: 'streamable-http' }));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ authorizationUrl: 'https://auth.example/authorize' }),
      });

      const handler = getRouteHandler('post', '/:id/oauth/start');
      const req: any = { userId: USER_A, params: { id: 'srv-1' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ authorizationUrl: 'https://auth.example/authorize' });
      expect(mockCreateState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ oxyUserId: USER_A, serverId: 'srv-1' }),
      );

      // The integrations service receives the NESTED config, reassembled from
      // the flat columns — it is a separate deploy and cannot read them.
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
      expect(body.config).toEqual({ url: 'https://mcp.github.test', requiresOAuth: true });
    });

    it('fails and removes the state when integrations does not return an authorization URL', async () => {
      mockFindServer.mockResolvedValue(serverRow({ runtime: 'server', transport: 'streamable-http' }));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      const handler = getRouteHandler('post', '/:id/oauth/start');
      const req: any = { userId: USER_A, params: { id: 'srv-1' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({ error: 'OAuth authorization URL was not returned' });
      expect(mockDeleteStateByToken).toHaveBeenCalledWith(expect.anything(), expect.any(String));
    });
  });

  describe('GET /oauth/callback — public, does not link', () => {
    it('redirects with mcp_oauth_state + mcp_oauth_code and never exchanges', async () => {
      mockFindState.mockResolvedValue({
        id: 'state-row-1',
        oxyUserId: USER_A,
        serverId: 'srv-1',
        createdAt: new Date(),
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

    it('redirects with error= when the state is expired', async () => {
      // Expiry is now the repository's decision — an expired row is simply not
      // returned — so the route's `!stateRow` branch covers both "unknown" and
      // "too old". Previously the route recomputed the age itself, in two
      // places, from two copies of the same arithmetic.
      mockFindState.mockResolvedValue(null);

      const handler = getRouteHandler('get', '/oauth/callback');
      const req: any = { query: { code: 'the-code', state: 'the-state' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.redirectUrl).toContain('error=oauth_expired');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('redirects with error= when code/state are missing', async () => {
      const handler = getRouteHandler('get', '/oauth/callback');
      const req: any = { query: {} };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      expect(res.redirectUrl).toContain('error=');
      expect(mockFindState).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('POST /install — idempotency on a taken name', () => {
    it('persists registry env values under config.env', async () => {
      mockInstall.mockResolvedValue(
        serverRow({ configEnv: { GITHUB_PERSONAL_ACCESS_TOKEN: 'token' } }),
      );

      const handler = getRouteHandler('post', '/install');
      const req: any = {
        userId: USER_A,
        body: {
          registryId: 'github',
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'token' },
        },
      };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(201);
      expect(mockInstall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          oxyUserId: USER_A,
          name: 'github',
          source: 'registry',
          config: expect.objectContaining({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'token' } }),
        }),
      );
      expect(res.body.server.config.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'token' });
    });

    it('returns 200 with the existing server on a duplicate registry install', async () => {
      // `null` is what the unique index decided, surfaced without a thrown
      // constraint violation.
      mockInstall.mockResolvedValue(null);
      mockFindByName.mockResolvedValue(serverRow({ id: 'existing-1' }));

      const handler = getRouteHandler('post', '/install');
      const req: any = { userId: USER_A, body: { registryId: 'github' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.server._id).toBe('existing-1');
      expect(mockFindByName).toHaveBeenCalledWith(expect.anything(), USER_A, 'github');
    });

    it('returns 409 on a duplicate CUSTOM install (no registryId)', async () => {
      mockInstall.mockResolvedValue(null);

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
      expect(mockFindByName).not.toHaveBeenCalled();
    });
  });

  describe('the list and delete routes serve the shape the mobile build reads', () => {
    it('answers 404 rather than 500 for an id of any shape', async () => {
      /**
       * A behaviour change worth a test. `_id: req.params.id` against a Mongo
       * `ObjectId` raised a `CastError` the route turned into a 500 for any
       * malformed id; `id` is `text`, so a malformed id simply matches nothing.
       * Loud to quiet, in the direction the caller deserved — and stated here so
       * it cannot be mistaken for an accident later.
       */
      mockDeleteServer.mockResolvedValue(null);

      const handler = getRouteHandler('delete', '/:id');
      const req: any = { userId: USER_A, params: { id: 'not-an-object-id-at-all' } };
      const res = makeMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Server not found' });
    });
  });
});
