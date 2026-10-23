import { registeredCatalog } from './fixtures/oxy-catalog.js';
/**
 * Somebody else using an agent (Alia ADR 0022): own tools reach the verified
 * requester's effective account, never the owner's data or an unrelated bot.
 * Every operation carries that requester's proof, without app-level grants.
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oxy-service-client.js', () => {
  const { OxyServer }: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)(
    '@oxy.so/core/server',
  );
  const client = new OxyServer({
    baseURL: 'https://api.oxy.so',
    serviceAuth: { apiKey: 'synthetic-app', apiSecret: 'synthetic-secret' },
  });
  return { oxyServiceClient: () => client, oxyServiceToken: async () => 'ALIA-SERVICE-TOKEN' };
});

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import { buildOxyServiceTools, type OxyToolExecutionContext } from '../tools/oxy-services.js';

const PERSON = 'person-1';
const AGENT = 'sindi-bot';

function tool(name: string, effect: 'read' | 'write', capabilityPackage: string) {
  return {
    name,
    version: '1.0.0',
    description: `${name} tool`,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      additionalProperties: false,
    },
    capabilityPackage,
    requiredCapabilities: [`homiio.${name}`],
    resourceTypes: ['homiio_account'],
    effect,
    idempotency: effect === 'read' ? 'none' : 'supported',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    invocation: { method: effect === 'read' ? 'GET' : 'POST', path: `/${name}` },
    limitKeys: [],
  };
}

const CATALOG = {
  schemaVersion: '1',
  appId: 'homiio',
  version: '1.0.0',
  audience: 'oxy-homiio-api',
  internalBaseUrl: 'https://homiio.example.test',
  accountResourceType: 'homiio_account',
  tools: [tool('searchListings', 'read', 'read'), tool('saveHome', 'write', 'create')],
  events: [],
};

const personRoot = {
  appId: 'homiio',
  effectiveAccountId: PERSON,
  resourceType: 'homiio_account',
  resourceId: PERSON,
};

interface ExecutableTool {
  description?: string;
  execute: (args: Record<string, unknown>, options?: { toolCallId?: string }) => Promise<unknown>;
}

let legacyCeilingAutonomy: 'read_only' | 'autonomous' = 'autonomous';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  legacyCeilingAutonomy = 'autonomous';
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token'))
      return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs'))
      return json({ registrations: [registeredCatalog(CATALOG)] });
    if (url.endsWith('/capabilities/service-identity'))
      return json({ service: { applicationId: 'alia-app', credentialId: 'alia-credential' } });
    if (url.endsWith('/capabilities/requester-capability-map')) {
      return json({
        assignments: [
          {
            ceilingId: 'ceiling-1',
            resource: personRoot,
            maximumAutonomy: legacyCeilingAutonomy,
            limits: [],
            toolNames:
              legacyCeilingAutonomy === 'read_only'
                ? ['searchListings']
                : ['searchListings', 'saveHome'],
          },
        ],
      });
    }
    if (url.endsWith('/capabilities/capability-map'))
      throw new Error('the owner-grant map must never be asked for a non-owner');
    if (
      url.endsWith('/capabilities/foreground-execution-authorizations') &&
      init?.method === 'POST'
    )
      return json({ authorization: { id: 'DIRECT-1' } }, 201);
    if (url.endsWith('/capabilities/tickets'))
      return json({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }, 201);
    if (url.startsWith('https://homiio.example.test/')) return json({ ok: true });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const context: OxyToolExecutionContext = {
  requesterAccountId: PERSON,
  ownerAccountId: PERSON,
  actor: { type: 'agent', accountId: AGENT },
  agentIdentity: { forUser: 'requester', self: false },
  runId: 'run-1',
  autonomy: 'execute_on_request',
  userAccessToken: 'PERSON-TOKEN',
};

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

function init(call: unknown[] | undefined): RequestInit {
  if (!call) throw new Error('Expected the request to have been sent');
  return call[1] as RequestInit;
}

function body(call: unknown[] | undefined): Record<string, unknown> {
  return JSON.parse(String(init(call).body)) as Record<string, unknown>;
}

describe('an agent used by somebody who is not its owner', () => {
  it("binds the person's own account without consulting legacy grants, and nothing of the owner or the bot", async () => {
    const tools = await buildOxyServiceTools(PERSON, context);
    expect(Object.keys(tools).sort()).toEqual([
      'oxy_homiio__saveHome',
      'oxy_homiio__searchListings',
    ]);
    expect(calls('/capabilities/requester-capability-map')).toHaveLength(0);
    expect(calls('/capabilities/capability-map')).toHaveLength(0);
    expect((tools.oxy_homiio__saveHome as unknown as ExecutableTool).description).toContain(
      'The PERSON you work for',
    );
  });

  it("acts as the person's own direct request with workload and requester proof, with no approval step", async () => {
    const tools = await buildOxyServiceTools(PERSON, context);
    const result = await (tools.oxy_homiio__saveHome as unknown as ExecutableTool).execute(
      { q: 'flat-1' },
      { toolCallId: 'call-1' },
    );
    expect(result).toEqual({ ok: true });
    const authorization = calls('/capabilities/foreground-execution-authorizations')[0];
    expect(init(authorization).headers).toMatchObject({
      Authorization: 'Bearer ALIA-SERVICE-TOKEN',
    });
    expect(body(authorization)).toMatchObject({
      kind: 'direct_request',
      authority: 'first_party',
      subjectToken: 'PERSON-TOKEN',
      actor: { type: 'agent', accountId: AGENT },
      resource: personRoot,
      tool: 'saveHome',
      expectedCatalog: expect.objectContaining({ registrationId: 'registration-homiio' }),
    });
  });

  it('does not apply a historical read-only app setting', async () => {
    legacyCeilingAutonomy = 'read_only';
    const tools = await buildOxyServiceTools(PERSON, context);
    expect(Object.keys(tools).sort()).toEqual([
      'oxy_homiio__saveHome',
      'oxy_homiio__searchListings',
    ]);
    expect(calls('/capabilities/requester-capability-map')).toHaveLength(0);
  });
});
