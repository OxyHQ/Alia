import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCapabilityCatalog } from '@oxy.so/contracts';

interface Row { agentId: string; appId: string; level: 'read' | 'act'; oxyGrantId: string }
const store = vi.hoisted(() => ({ rows: [] as Array<{ agentId: string; appId: string; level: 'read' | 'act'; oxyGrantId: string }> }));

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/agentOxyAppPermissionRepository.js', () => ({
  listAgentOxyAppPermissions: vi.fn(async (_db: unknown, agentId: string) => store.rows.filter((row) => row.agentId === agentId)),
  upsertAgentOxyAppPermission: vi.fn(async (_db: unknown, input: Row) => {
    store.rows = [...store.rows.filter((row) => !(row.agentId === input.agentId && row.appId === input.appId)), input];
  }),
  deleteAgentOxyAppPermission: vi.fn(async (_db: unknown, agentId: string, appId: string) => {
    store.rows = store.rows.filter((row) => !(row.agentId === agentId && row.appId === appId));
  }),
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

function tool(name: string, effect: 'read' | 'write' | 'external' | 'financial', capabilityPackage: string) {
  return {
    name, version: '1.0.0', description: name,
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    capabilityPackage, requiredCapabilities: [`x.${name}`], resourceTypes: ['email_account'],
    effect, idempotency: effect === 'read' ? 'none' : 'required', rollback: 'none',
    exposure: ['internal'], invocation: { method: 'GET', path: `/${name}` }, limitKeys: [],
  };
}

const INBOX = {
  schemaVersion: '1', appId: 'inbox', version: '1.0.0', audience: 'inbox-api',
  internalBaseUrl: 'https://inbox.example.test', accountResourceType: 'email_account',
  tools: [
    tool('searchEmails', 'read', 'read'),
    tool('listThreads', 'read', 'communicate'),
    tool('sendEmail', 'external', 'communicate'),
    tool('archiveEmail', 'write', 'create'),
    tool('payInvoice', 'financial', 'finance'),
  ],
  events: [],
} as unknown as AppCapabilityCatalog;

vi.mock('../tools/oxy-services.js', () => ({ listOxyAppCatalogs: vi.fn(async () => [INBOX]) }));

import {
  AgentOxyAppsError,
  grantTermsForLevel,
  levelOfGrant,
  listAgentOxyApps,
  revokeAllAgentOxyApps,
  setAgentOxyAppLevel,
} from '../agent-oxy-apps.js';

const OWNER = 'owner-1';
const AGENT = { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: OWNER };

interface Grant {
  id: string; maximumAutonomy: string; revokedAt: string | null; expiresAt: string | null; createdAt: string;
  actor: { type: 'agent'; accountId: string };
  resource: { appId: string; effectiveAccountId: string; resourceType: string; resourceId: string };
}
let grants: Grant[];
let fetchMock: ReturnType<typeof vi.fn>;
let nextId: number;

function grant(id: string, maximumAutonomy: string, overrides: Partial<Grant> = {}): Grant {
  return {
    id, maximumAutonomy, revokedAt: null, expiresAt: null, createdAt: new Date(Date.now() - Number(id.replace(/\D/g, '') || 0)).toISOString(),
    actor: { type: 'agent', accountId: AGENT.oxyAccountId },
    resource: { appId: 'inbox', effectiveAccountId: OWNER, resourceType: 'email_account', resourceId: OWNER },
    ...overrides,
  };
}

beforeEach(() => {
  store.rows = [];
  grants = [];
  nextId = 100;
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer OWNER-TOKEN');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/capabilities/grants' && method === 'GET') {
      expect(url.searchParams.get('ownerAccountId')).toBe(OWNER);
      return Response.json({ grants });
    }
    if (url.pathname === '/capabilities/grants' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const created = grant(`grant-${nextId++}`, String(body.maximumAutonomy), { createdAt: new Date().toISOString() });
      grants.push(created);
      return Response.json({ grant: created }, { status: 201 });
    }
    const match = /^\/capabilities\/grants\/(.+)$/.exec(url.pathname);
    if (match && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const found = grants.find((entry) => entry.id === match[1]);
      if (!found) return new Response('missing', { status: 404 });
      found.maximumAutonomy = String(body.maximumAutonomy);
      return Response.json({ grant: found });
    }
    if (match && method === 'DELETE') {
      const found = grants.find((entry) => entry.id === match[1]);
      if (found) found.revokedAt = new Date().toISOString();
      return new Response(null, { status: found ? 204 : 404 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function sent(method: string, path?: string) {
  return fetchMock.mock.calls
    .filter(([input, init]) => (init as RequestInit | undefined)?.method === method
      && (path === undefined || new URL(String(input)).pathname === path))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body ?? 'null')) as Record<string, unknown>);
}

describe('levels in Oxy vocabulary', () => {
  it('maps Ver to the read packages at read_only and Ver y actuar to every non-sensitive package at autonomous', () => {
    expect(grantTermsForLevel(INBOX, 'read')).toEqual({ capabilityPackages: ['communicate', 'read'], maximumAutonomy: 'read_only' });
    expect(grantTermsForLevel(INBOX, 'act')).toEqual({
      capabilityPackages: ['communicate', 'create', 'read'], maximumAutonomy: 'autonomous',
    });
  });

  it('never grants a sensitive package through a level', () => {
    const financeOnly = { ...INBOX, tools: [tool('payInvoice', 'financial', 'finance')] } as unknown as AppCapabilityCatalog;
    expect(grantTermsForLevel(financeOnly, 'act')).toBeNull();
    expect(grantTermsForLevel(INBOX, 'act')?.capabilityPackages).not.toContain('finance');
  });

  it('reads a grant made elsewhere by its autonomy', () => {
    expect(levelOfGrant('read_only')).toBe('read');
    expect(levelOfGrant('draft')).toBe('read');
    expect(levelOfGrant('execute_on_request')).toBe('act');
    expect(levelOfGrant('autonomous')).toBe('act');
  });
});

describe('setting a level', () => {
  it('creates one grant over the owner\'s account root with the owner\'s bearer, then records it', async () => {
    await expect(setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'read')).resolves.toMatchObject({
      appId: 'inbox', name: 'Inbox', level: 'read', levels: ['none', 'read', 'act'],
    });
    expect(sent('POST', '/capabilities/grants')).toEqual([{
      capabilityPackages: ['communicate', 'read'], capabilities: [], toolOverrides: [], limits: [],
      maximumAutonomy: 'read_only', canRedelegate: false, expiresAt: null,
      ownerAccountId: OWNER, actorAccountId: 'bot-1',
      resource: { appId: 'inbox', effectiveAccountId: OWNER, resourceType: 'email_account', resourceId: OWNER },
    }]);
    expect(store.rows).toEqual([{ agentId: 'agent-1', appId: 'inbox', level: 'read', oxyGrantId: 'grant-100' }]);
  });

  it('updates the same grant when the level changes, and revokes it at Nada', async () => {
    await setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'read');
    await setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'act');
    expect(sent('POST', '/capabilities/grants')).toHaveLength(1);
    expect(sent('PUT')).toEqual([expect.objectContaining({ maximumAutonomy: 'autonomous' })]);
    expect(store.rows).toEqual([{ agentId: 'agent-1', appId: 'inbox', level: 'act', oxyGrantId: 'grant-100' }]);

    await setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'none');
    expect(grants[0]?.revokedAt).not.toBeNull();
    expect(store.rows).toEqual([]);
  });

  it('folds duplicate grants into one', async () => {
    grants = [grant('grant-1', 'read_only'), grant('grant-2', 'autonomous')];
    await setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'act');
    expect(grants.filter((entry) => entry.revokedAt === null)).toHaveLength(1);
  });

  it('stores nothing when Oxy refuses, and says who may change it', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ grants: [] }));
    fetchMock.mockImplementationOnce(async () => new Response('no', { status: 403 }));
    await expect(setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'act')).rejects.toMatchObject({
      status: 403, code: 'owner_authority_required',
    });
    expect(store.rows).toEqual([]);
  });

  it('refuses an app that does not exist and an agent without an owner', async () => {
    await expect(setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'nope', 'read')).rejects.toBeInstanceOf(AgentOxyAppsError);
    await expect(setAgentOxyAppLevel({ ...AGENT, ownerOxyAccountId: null }, 'OWNER-TOKEN', 'inbox', 'read'))
      .rejects.toMatchObject({ code: 'agent_owner_unknown' });
  });
});

describe('reading the levels', () => {
  it('starts at Nada for every app', async () => {
    await expect(listAgentOxyApps(AGENT, 'OWNER-TOKEN')).resolves.toEqual([
      { appId: 'inbox', name: 'Inbox', level: 'none', levels: ['none', 'read', 'act'] },
    ]);
  });

  it('drops a level whose grant was revoked in the Agency tab', async () => {
    await setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'read');
    const [first] = grants;
    if (first) first.revokedAt = new Date().toISOString();
    await expect(listAgentOxyApps(AGENT, 'OWNER-TOKEN')).resolves.toMatchObject([{ level: 'none' }]);
    expect(store.rows).toEqual([]);
  });

  it('adopts a grant made elsewhere, and ignores grants to other actors or resources', async () => {
    grants = [
      grant('grant-7', 'execute_on_request'),
      grant('grant-8', 'autonomous', { actor: { type: 'agent', accountId: 'another-bot' } }),
      grant('grant-9', 'autonomous', { resource: { appId: 'inbox', effectiveAccountId: OWNER, resourceType: 'mailbox', resourceId: 'box' } }),
    ];
    await expect(listAgentOxyApps(AGENT, 'OWNER-TOKEN')).resolves.toMatchObject([{ level: 'act' }]);
    expect(store.rows).toEqual([{ agentId: 'agent-1', appId: 'inbox', level: 'act', oxyGrantId: 'grant-7' }]);
  });
});

it('revokes every level of a deleted agent and survives Oxy failing', async () => {
  await setAgentOxyAppLevel(AGENT, 'OWNER-TOKEN', 'inbox', 'act');
  fetchMock.mockImplementationOnce(async () => new Response('down', { status: 503 }));
  await expect(revokeAllAgentOxyApps(AGENT, 'OWNER-TOKEN')).resolves.toBeUndefined();
  await revokeAllAgentOxyApps(AGENT, 'OWNER-TOKEN');
  expect(grants[0]?.revokedAt).not.toBeNull();
});
