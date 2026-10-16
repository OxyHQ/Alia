/**
 * What an agent may do for whoever uses it, per app (ADR 0020 §2): the editor's
 * three levels written as Oxy ceilings with the operator's bearer, read back
 * from Oxy's live ceilings, and the same package choice as the owner levels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCapabilityCatalog } from '@oxy.so/contracts';

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

function tool(name: string, effect: 'read' | 'write' | 'financial', capabilityPackage: string) {
  return {
    name,
    version: '1.0.0',
    description: name,
    inputSchema: { type: 'object' },
    capabilityPackage,
    requiredCapabilities: [`homiio.${name}`],
    resourceTypes: ['homiio_account'],
    effect,
    idempotency: effect === 'read' ? 'none' : 'required',
    rollback: 'none',
    exposure: ['internal'],
    invocation: { method: effect === 'read' ? 'GET' : 'POST', path: `/${name}` },
    limitKeys: [],
  };
}

const HOMIIO = {
  schemaVersion: '1',
  appId: 'homiio',
  version: '1.0.0',
  audience: 'oxy-homiio-api',
  internalBaseUrl: 'https://homiio.example.test',
  accountResourceType: 'homiio_account',
  tools: [
    tool('searchListings', 'read', 'read'),
    tool('saveHome', 'write', 'create'),
    tool('payRent', 'financial', 'finance'),
  ],
  events: [],
} as unknown as AppCapabilityCatalog;

vi.mock('../tools/oxy-services.js', () => ({ listOxyAppCatalogs: vi.fn(async () => [HOMIIO]) }));

const { listAgentRequesterApps, setAgentRequesterAppLevel } = await import(
  '../agent-requester-apps.js'
);

const AGENT = { _id: 'agent-1', oxyAccountId: 'sindi-bot' };
let ceilings: Array<{ appId: string; maximumAutonomy: string; revokedAt: string | null }> = [];
let refuse = false;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ceilings = [];
  refuse = false;
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (refuse) return new Response('{}', { status: 403 });
    const url = String(input);
    if (url.endsWith('/capabilities/agent-ceilings/sindi-bot') && !init?.method)
      return Response.json({ ceilings });
    if (url.endsWith('/capabilities/agent-ceilings/sindi-bot/homiio') && init?.method === 'PUT')
      return Response.json({ ceiling: {} }, { status: 201 });
    if (url.endsWith('/capabilities/agent-ceilings/sindi-bot/homiio') && init?.method === 'DELETE')
      return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function lastBody() {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('Expected a request to Oxy');
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('an agent’s levels for the people who use it', () => {
  it('reads each app at the level of its live ceiling', async () => {
    expect(await listAgentRequesterApps(AGENT, 'OPERATOR')).toEqual([
      { appId: 'homiio', name: 'Homiio', level: 'none', levels: ['none', 'read', 'act'] },
    ]);
    ceilings = [{ appId: 'homiio', maximumAutonomy: 'autonomous', revokedAt: null }];
    expect((await listAgentRequesterApps(AGENT, 'OPERATOR'))[0]?.level).toBe('act');
    ceilings = [{ appId: 'homiio', maximumAutonomy: 'read_only', revokedAt: null }];
    expect((await listAgentRequesterApps(AGENT, 'OPERATOR'))[0]?.level).toBe('read');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer OPERATOR' }),
    });
  });

  it('publishes "Ver y actuar" as every non-sensitive package, autonomous, and "Ver" as reads', async () => {
    await setAgentRequesterAppLevel(AGENT, 'OPERATOR', 'homiio', 'act');
    expect(lastBody()).toEqual({
      capabilityPackages: ['create', 'read'],
      capabilities: [],
      toolOverrides: [],
      limits: [],
      maximumAutonomy: 'autonomous',
    });
    await setAgentRequesterAppLevel(AGENT, 'OPERATOR', 'homiio', 'read');
    expect(lastBody()).toMatchObject({
      capabilityPackages: ['read'],
      maximumAutonomy: 'read_only',
    });
  });

  it('revokes for "Nada", and says plainly who may change it', async () => {
    expect((await setAgentRequesterAppLevel(AGENT, 'OPERATOR', 'homiio', 'none')).level).toBe(
      'none',
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE' });
    refuse = true;
    await expect(
      setAgentRequesterAppLevel(AGENT, 'STRANGER', 'homiio', 'act'),
    ).rejects.toMatchObject({ status: 403, code: 'agent_operator_required' });
  });
});
