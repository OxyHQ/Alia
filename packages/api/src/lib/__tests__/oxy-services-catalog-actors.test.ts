/**
 * Catalogue `actors` (Oxy ADR 0018, addendum 2026-10-11): a tool Oxy will only
 * authorize for a present requester — the Oxy profile reads — is never offered
 * to Alia or to an agent, and one catalogue this Alia cannot parse costs that
 * app's tools, never every other app's.
 */
import { createRequire } from 'node:module';
import { canonicalCapabilityJson } from '@oxy.so/contracts';
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

const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: logged.error, debug: vi.fn() };
  return { log: { general: child, agents: child } };
});

const USER = 'user-1';
const AGENT = 'agent-bot-1';

function readTool(name: string, path: string, resourceType: string, extra = {}) {
  return {
    name,
    version: '1.0.0',
    description: `${name} tool`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    capabilityPackage: 'read',
    requiredCapabilities: [`${name}.read`],
    resourceTypes: [resourceType],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [],
    invocation: { method: 'GET', path },
    ...extra,
  };
}

const INBOX = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '1.0.0',
  audience: 'oxy-inbox-api',
  internalBaseUrl: 'https://inbox.example.test',
  accountResourceType: 'email_account',
  tools: [readTool('searchEmails', '/email/search', 'email_account')],
  events: [],
};

/** The shape of Oxy's profile catalogue 1.1.0: every tool is requester-only. */
const OXY = {
  schemaVersion: '1',
  appId: 'oxy',
  version: '1.1.0',
  audience: 'oxy-platform-api',
  internalBaseUrl: 'https://api.oxy.so',
  accountResourceType: 'account',
  tools: [
    readTool('readViewerGraph', '/_oxy/capabilities/users/me/graph', 'account', {
      actors: ['requester'],
    }),
    readTool('listPublicProfiles', '/_oxy/capabilities/profiles', 'account', {
      actors: ['alia', 'requester'],
    }),
  ],
  events: [],
};

let registrations: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  logged.error.mockClear();
  registrations = [{ catalog: INBOX }, { catalog: OXY }];
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token'))
      return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs')) return json({ registrations });
    if (url.endsWith('/capabilities/capability-map')) {
      // Even a capability map that named a requester-only tool binds nothing.
      return json({
        assignments: [
          {
            grantId: 'grant-1',
            resource: {
              appId: 'oxy',
              effectiveAccountId: USER,
              resourceType: 'account',
              resourceId: USER,
            },
            maximumAutonomy: 'read_only',
            limits: [],
            toolNames: ['readViewerGraph', 'listPublicProfiles'],
          },
        ],
      });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

async function services() {
  return import('../tools/oxy-services.js');
}

describe('catalogue actors', () => {
  it('never offers Alia a tool only a present requester may run', async () => {
    const { buildOxyServiceTools } = await services();
    const tools = await buildOxyServiceTools(USER, {
      requesterAccountId: USER,
      ownerAccountId: USER,
      actor: { type: 'alia', ownerAccountId: USER },
      userAccessToken: 'USER-BEARER',
    });
    expect(Object.keys(tools).sort()).toEqual([
      'oxy_inbox__searchEmails',
      'oxy_oxy__listPublicProfiles',
    ]);
  });

  it('never offers an agent, as itself or for its owner, a tool its actor type cannot run', async () => {
    const { buildOxyServiceTools } = await services();
    const tools = await buildOxyServiceTools(USER, {
      requesterAccountId: USER,
      ownerAccountId: USER,
      actor: { type: 'agent', accountId: AGENT },
      agentIdentity: { forUser: 'owner', self: true },
      userAccessToken: 'USER-BEARER',
    });
    // `listPublicProfiles` names Alia but not agents; `readViewerGraph` names
    // neither. Inbox declares nothing, so both identities keep it.
    expect(Object.keys(tools).sort()).toEqual(['self_inbox__searchEmails']);
  });

  it('keeps an undeclared tool for every standing actor', async () => {
    const { listOxyAccountReadTools } = await services();
    expect(await listOxyAccountReadTools(USER)).toEqual([
      {
        resource: {
          appId: 'inbox',
          effectiveAccountId: USER,
          resourceType: 'email_account',
          resourceId: USER,
        },
        tool: 'searchEmails',
      },
      {
        resource: {
          appId: 'oxy',
          effectiveAccountId: USER,
          resourceType: 'account',
          resourceId: USER,
        },
        tool: 'listPublicProfiles',
      },
    ]);
  });

  it("does not advertise a requester-only tool in Alia's prompt", async () => {
    const { buildOxyServiceTools, getOxyServicePromptFragment } = await services();
    await buildOxyServiceTools(USER, {
      requesterAccountId: USER,
      ownerAccountId: USER,
      actor: { type: 'alia', ownerAccountId: USER },
    });
    const prompt = getOxyServicePromptFragment(USER);
    expect(prompt).toContain('oxy_inbox__searchEmails');
    expect(prompt).toContain('oxy_oxy__listPublicProfiles');
    expect(prompt).not.toContain('readViewerGraph');
  });

  it('offers an agent no level on an app whose tools no agent may run', async () => {
    const { grantTermsForLevel } = await import('../agent-oxy-apps.js');
    const { parseRegistryCatalog } = await import('../tools/oxy-catalog-actors.js');
    const oxy = parseRegistryCatalog(OXY);
    expect(grantTermsForLevel(oxy, 'read')).toBeNull();
    expect(grantTermsForLevel(oxy, 'act')).toBeNull();
    expect(grantTermsForLevel(parseRegistryCatalog(INBOX), 'read')).not.toBeNull();
  });
});

describe('one catalogue that does not parse', () => {
  it("costs that app's tools only, and is logged", async () => {
    registrations = [
      { catalog: { ...OXY, tools: [{ ...OXY.tools[0], actors: ['owner'] }] } },
      { catalog: { appId: 'broken', schemaVersion: '2' } },
      { catalog: INBOX },
    ];
    const { buildOxyServiceTools } = await services();
    const tools = await buildOxyServiceTools(USER, {
      requesterAccountId: USER,
      ownerAccountId: USER,
      actor: { type: 'alia', ownerAccountId: USER },
      userAccessToken: 'USER-BEARER',
    });
    expect(Object.keys(tools)).toEqual(['oxy_inbox__searchEmails']);
    expect(logged.error).toHaveBeenCalledTimes(2);
    expect(logged.error.mock.calls.map(([fields]) => fields.appId)).toEqual(['oxy', 'broken']);
  });
});

describe('parseRegistryCatalog', () => {
  it('reads `actors` with the installed contracts, and keeps the registered catalogue intact', async () => {
    const { parseRegistryCatalog, catalogToolActorsOf } = await import(
      '../tools/oxy-catalog-actors.js'
    );
    const parsed = parseRegistryCatalog(OXY);
    expect(parsed.tools.map((tool) => catalogToolActorsOf(tool))).toEqual([
      ['requester'],
      ['alia', 'requester'],
    ]);
    // Same canonical JSON as the registry's (the internal MCP pilot digests it).
    expect(canonicalCapabilityJson(parsed)).toBe(canonicalCapabilityJson(OXY));
    const [inboxTool] = parseRegistryCatalog(INBOX).tools;
    expect(inboxTool && catalogToolActorsOf(inboxTool)).toEqual(['alia', 'agent']);
  });

  it('still refuses what the strict schema refuses', async () => {
    const { parseRegistryCatalog } = await import('../tools/oxy-catalog-actors.js');
    const [tool] = OXY.tools;
    for (const tools of [
      [{ ...tool, actors: [] }],
      [{ ...tool, actors: ['requester', 'requester'] }],
      [{ ...tool, actors: 'requester' }],
      [{ ...tool, executors: ['alia'] }],
    ])
      expect(() => parseRegistryCatalog({ ...OXY, tools })).toThrow();
  });
});
