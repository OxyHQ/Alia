import { registeredCatalog } from './fixtures/oxy-catalog.js';
/** Published SDK over owned loopback; the remote authority is synthetic. */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateOxyExecutionAuthorizationInput } from '../oxy-capability-authority.js';
const state = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('../oxy-service-client.js', () => ({
  oxyServiceClient: () => state.client,
  oxyServiceToken: async () => 'fixture-service-token',
}));
const real: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)(
  '@oxy.so/core/server',
);
let server: Server;
let status: number;
let calls: Array<{ method: string; path: string; bearer?: string; body: Record<string, unknown> }>;
let authority: typeof import('../oxy-capability-authority.js');
beforeEach(async () => {
  vi.resetModules();
  status = 201;
  calls = [];
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => {
      text += String(chunk);
    });
    req.on('end', () => {
      const path = req.url ?? '';
      if (path === '/auth/service-token') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ token: 'fixture-service-token', expiresIn: 300 }));
        return;
      }
      calls.push({
        method: req.method ?? '',
        path,
        bearer: req.headers.authorization,
        body: text ? JSON.parse(text) : {},
      });
      res.setHeader('content-type', 'application/json');
      if (path === '/capabilities/catalogs') {
        res.end(
          JSON.stringify({
            registrations: [
              registeredCatalog({
                schemaVersion: '1',
                appId: 'inbox',
                version: '1.0.0',
                audience: 'oxy-inbox',
                internalBaseUrl: 'https://inbox.test',
                accountResourceType: 'mailbox',
                tools: [],
                events: [],
              }),
            ],
          }),
        );
        return;
      }
      if (path === '/capabilities/service-identity') {
        res.end(
          JSON.stringify({
            service: { applicationId: 'fixture-app', credentialId: 'fixture-credential' },
          }),
        );
        return;
      }
      res.statusCode = status;
      res.end(
        JSON.stringify(
          status >= 400
            ? { message: 'fixture rejection' }
            : { authorization: { id: 'fixture-approval' } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('OXY_API_URL', baseURL);
  state.client = new real.OxyServer({
    baseURL,
    serviceAuth: { apiKey: 'fixture-key', apiSecret: 'fixture-secret' },
  });
  authority = await import('../oxy-capability-authority.js');
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  state.client = undefined;
  vi.unstubAllEnvs();
});
function input(): CreateOxyExecutionAuthorizationInput {
  return {
    accessToken: 'fixture-requester',
    kind: 'direct_request',
    ownerAccountId: 'owner',
    actor: { type: 'alia', ownerAccountId: 'owner' },
    resource: {
      appId: 'inbox',
      effectiveAccountId: 'owner',
      resourceType: 'mailbox',
      resourceId: 'box',
    },
    tool: 'read',
    runId: 'run',
    maximumAutonomy: 'read_only',
    limits: [],
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  };
}
describe('one canonical requester authority transport', () => {
  it.each(['direct_request', 'automation'] as const)(
    'preserves %s terms and requester bearer',
    async (kind) => {
      const request =
        kind === 'automation'
          ? {
              ...input(),
              kind,
              runId: undefined,
              automationId: 'automation',
              maximumAutonomy: 'autonomous' as const,
            }
          : input();
      expect(await authority.createOxyExecutionAuthorization(request)).toBe('fixture-approval');
      expect(calls).toHaveLength(2);
      expect(calls[0].bearer).toBe('Bearer fixture-service-token');
      expect(calls[1]).toMatchObject({
        method: 'POST',
        path: '/capabilities/foreground-execution-authorizations',
        bearer: 'Bearer fixture-service-token',
        body: {
          kind,
          authority: 'first_party',
          subjectToken: 'fixture-requester',
          resource: request.resource,
          limits: [],
          expiresAt: request.expiresAt.toISOString(),
          ...(kind === 'automation' ? { automationId: 'automation' } : { runId: 'run' }),
        },
      });
      expect(calls[1].body).not.toHaveProperty(kind === 'automation' ? 'runId' : 'automationId');
    },
  );
  it.each([401, 403, 503])('does not replay writes after HTTP%s', async (code) => {
    status = code;
    await expect(authority.createOxyExecutionAuthorization(input())).rejects.toThrow();
    await expect(
      authority.revokeOxyExecutionAuthorization('fixture-requester', 'approval'),
    ).rejects.toThrow();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });
  it('retires with requester authority and accepts an already missing row', async () => {
    status = 404;
    await authority.revokeOxyExecutionAuthorization('fixture-requester', 'approval/id');
    expect(calls).toEqual([
      {
        method: 'DELETE',
        path: '/capabilities/execution-authorizations/approval%2Fid',
        bearer: 'Bearer fixture-requester',
        body: {},
      },
    ]);
  });
  it('refuses mixed direct/automation terms before creating authority', async () => {
    for (const request of [
      { ...input(), automationId: 'not-direct' },
      { ...input(), kind: 'automation' as const, automationId: 'automation' },
      { ...input(), runId: undefined },
    ])
      await expect(authority.createOxyExecutionAuthorization(request)).rejects.toThrow();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
  it('calls installed SDK create/retire rather than app-local writes', async () => {
    const client = state.client as InstanceType<typeof real.OxyServer>;
    const create = vi.spyOn(client.agency, 'createForegroundExecutionAuthorization');
    const revoke = vi.spyOn(client.agency, 'revokeExecutionAuthorization');
    await authority.createOxyExecutionAuthorization({
      ...input(),
      kind: 'automation',
      runId: undefined,
      automationId: 'automation',
    });
    await authority.revokeOxyExecutionAuthorization('fixture-requester', 'approval');
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
