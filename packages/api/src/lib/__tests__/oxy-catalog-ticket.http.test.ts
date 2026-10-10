import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyToolExecutionContext } from '../tools/oxy-services.js';

const state = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('../oxy-service-client.js', () => ({
  oxyServiceClient: () => state.client,
  oxyServiceToken: () => (state.client as { serviceToken(): Promise<string> }).serviceToken(),
}));
vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
const { OxyServer } = createRequire(import.meta.url)(
  '@oxy.so/core/server',
) as typeof import('@oxy.so/core/server');
let server: Server;
let origin: string;
let calls: Array<{
  path: string;
  method: string;
  authorization?: string;
  body: Record<string, unknown>;
}>;
let denied: { path: string; status: number } | undefined;
let module: typeof import('../tools/oxy-services.js');
const context: OxyToolExecutionContext = {
  requesterAccountId: 'owned-user',
  ownerAccountId: 'owned-user',
  actor: { type: 'alia', ownerAccountId: 'owned-user' },
  runId: 'owned-run',
  userAccessToken: 'owned-requester',
};

beforeEach(async () => {
  vi.resetModules();
  calls = [];
  denied = undefined;
  const catalog = () => ({
    schemaVersion: '1',
    appId: 'inbox',
    version: '1.0.0',
    audience: 'synthetic-inbox',
    internalBaseUrl: origin,
    accountResourceType: 'email_account',
    tools: [
      {
        name: 'searchEmails',
        version: '1.0.0',
        description: 'Synthetic search',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object' },
        capabilityPackage: 'read',
        requiredCapabilities: ['email.read'],
        resourceTypes: ['email_account'],
        effect: 'read',
        idempotency: 'none',
        rollback: 'none',
        exposure: ['internal'],
        invocation: { method: 'GET', path: '/product/search' },
        limitKeys: [],
      },
    ],
    events: [],
  });
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = req.url ?? '/';
    calls.push({
      path,
      method: req.method ?? 'GET',
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : {},
    });
    res.setHeader('Content-Type', 'application/json');
    if (denied?.path === path) {
      res.writeHead(denied.status);
      res.end(JSON.stringify({ error: 'synthetic refusal' }));
      return;
    }
    const data: Record<string, unknown> = {
      '/auth/service-token': { token: 'owned-service', expiresIn: 300 },
      '/capabilities/catalogs': { registrations: [{ catalog: catalog() }] },
      '/capabilities/service-identity': {
        service: { applicationId: 'owned-app', credentialId: 'owned-credential' },
      },
      '/capabilities/execution-authorizations': { authorization: { id: 'owned-approval' } },
      '/capabilities/tickets': {
        decision: { allowed: true, reason: 'allowed' },
        ticket: 'owned-ticket',
      },
      '/product/search': { data: ['owned-result'] },
    };
    if (
      path === '/capabilities/execution-authorizations/owned-approval' &&
      req.method === 'DELETE'
    ) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!(path in data)) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.end(JSON.stringify(data[path]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('OXY_API_URL', origin);
  vi.stubEnv('ALIA_INTERNAL_MCP_PILOT', undefined);
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).origin !== origin)
      throw new Error('Fixture refuses non-owned network');
    return realFetch(url, init);
  });
  state.client = new OxyServer({
    baseURL: origin,
    serviceAuth: { apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' },
  });
  module = await import('../tools/oxy-services.js');
});
afterEach(async () => {
  (state.client as InstanceType<typeof OxyServer>)?.dispose();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('non-pilot catalog and ticket authority through installed SDK', () => {
  async function invoke() {
    const tools = await module.buildOxyServiceTools('owned-user', context);
    const tool = tools.oxy_inbox__searchEmails as unknown as
      | { execute(args: Record<string, unknown>): Promise<unknown> }
      | undefined;
    return tool ? tool.execute({}) : undefined;
  }
  it('uses canonical agency methods and keeps requester/service/product authority distinct', async () => {
    const client = state.client as InstanceType<typeof OxyServer>;
    const catalogs = vi.spyOn(client.agency, 'serviceCatalogs');
    const tickets = vi.spyOn(client.agency, 'issueCapabilityTicket');
    expect(await invoke()).toEqual({ data: ['owned-result'] });
    expect(catalogs).toHaveBeenCalledTimes(1);
    expect(tickets).toHaveBeenCalledTimes(1);
    expect(
      calls.filter(
        (c) => c.path === '/capabilities/catalogs' || c.path === '/capabilities/tickets',
      ),
    ).toEqual([
      expect.objectContaining({
        path: '/capabilities/catalogs',
        method: 'GET',
        authorization: 'Bearer owned-service',
      }),
      expect.objectContaining({
        path: '/capabilities/tickets',
        method: 'POST',
        authorization: 'Bearer owned-service',
        body: { executionAuthorizationId: 'owned-approval' },
      }),
    ]);
    expect(
      calls.find((c) => c.path === '/capabilities/execution-authorizations')?.authorization,
    ).toBe('Bearer owned-requester');
    expect(calls.find((c) => c.path === '/product/search')?.authorization).toBe(
      'Capability owned-ticket',
    );
    expect(calls.find((c) => c.method === 'DELETE')?.authorization).toBe('Bearer owned-requester');
  });
  it.each([401, 403, 503])(
    'does not retry denied catalog %s or execute an app effect',
    async (status) => {
      denied = { path: '/capabilities/catalogs', status };
      expect(await invoke()).toBeUndefined();
      expect(calls.filter((c) => c.path === '/capabilities/catalogs')).toHaveLength(1);
      expect(
        calls.some((c) => c.path === '/product/search' || c.path === '/capabilities/tickets'),
      ).toBe(false);
    },
  );
  it.each([401, 403, 503])(
    'does not retry denied ticket %s and retires only the existing approval',
    async (status) => {
      denied = { path: '/capabilities/tickets', status };
      expect(await invoke()).toMatchObject({ error: 'oxy_app_unavailable' });
      expect(calls.filter((c) => c.path === '/capabilities/tickets')).toHaveLength(1);
      expect(calls.some((c) => c.path === '/product/search')).toBe(false);
      expect(calls.filter((c) => c.method === 'DELETE')).toEqual([
        expect.objectContaining({
          path: '/capabilities/execution-authorizations/owned-approval',
          authorization: 'Bearer owned-requester',
        }),
      ]);
    },
  );
});
