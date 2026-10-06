/**
 * An agent's two identities (ADR 0015): the owner's apps per the levels the
 * owner set (`oxy_*`), and its own bot account (`self_*`) — and how each call
 * is authorized with the owner present (bearer) and with nobody present (Oxy's
 * agent-run lane, requester derived by Oxy).
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oxy-service-client.js', () => {
  const { OxyServer }: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)('@oxy.so/core/server');
  const client = new OxyServer({ baseURL: 'https://api.oxy.so', serviceAuth: { apiKey: 'synthetic-app', apiSecret: 'synthetic-secret' } });
  return { oxyServiceClient: () => client, oxyServiceToken: async () => 'ALIA-SERVICE-TOKEN' };
});

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import {
  agentIdentityPrompt,
  buildOxyServiceTools,
  type OxyAgentIdentity,
  type OxyToolAutonomy,
  type OxyToolExecutionContext,
} from '../tools/oxy-services.js';

const OWNER = 'owner-1';
const AGENT = 'agent-bot-1';

function tool(name: string, effect: 'read' | 'external', capabilityPackage: string, method: 'GET' | 'POST', path: string) {
  return {
    name,
    version: '1.0.0',
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object' },
    capabilityPackage,
    requiredCapabilities: [`email.${name}`],
    resourceTypes: ['email_account'],
    effect,
    idempotency: effect === 'read' ? 'none' : 'required',
    rollback: 'none',
    exposure: ['internal'],
    invocation: { method, path },
    limitKeys: [],
  };
}

const CATALOG = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '1.0.0',
  audience: 'oxy-inbox-api',
  internalBaseUrl: 'https://inbox.example.test',
  accountResourceType: 'email_account',
  tools: [
    tool('searchEmails', 'read', 'read', 'GET', '/email/search'),
    tool('sendEmail', 'external', 'communicate', 'POST', '/email/send'),
  ],
  events: [],
};

interface ExecutableTool {
  description?: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

let grantAutonomy: OxyToolAutonomy = 'read_only';
let fetchMock: ReturnType<typeof vi.fn>;

const ownerRoot = { appId: 'inbox', effectiveAccountId: OWNER, resourceType: 'email_account', resourceId: OWNER };

beforeEach(() => {
  grantAutonomy = 'read_only';
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token')) return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs')) return json({ registrations: [{ catalog: CATALOG }] });
    if (url.endsWith('/capabilities/service-identity')) {
      return json({ service: { applicationId: 'alia-app', credentialId: 'alia-credential' } });
    }
    if (url.endsWith('/capabilities/capability-map')) {
      return json({ assignments: [{
        grantId: 'grant-1',
        resource: ownerRoot,
        maximumAutonomy: grantAutonomy,
        limits: [],
        // Oxy lists every tool of a granted package; the level decides which run.
        toolNames: ['searchEmails', 'sendEmail'],
      }] });
    }
    if (url.endsWith('/capabilities/execution-authorizations') && init?.method === 'POST') {
      return json({ authorization: { id: 'DIRECT-1' } }, 201);
    }
    if (url.endsWith('/capabilities/agent-run-authorizations')) return json({ authorization: { id: 'RUN-1' } }, 201);
    if (url.endsWith('/capabilities/tickets')) {
      return json({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }, 201);
    }
    if (url.startsWith('https://inbox.example.test/')) return json({ data: [] });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function agentContext(identity: OxyAgentIdentity, bearer = true): OxyToolExecutionContext {
  return {
    requesterAccountId: OWNER,
    ownerAccountId: OWNER,
    actor: { type: 'agent', accountId: AGENT },
    agentIdentity: identity,
    runId: 'run-1',
    autonomy: 'execute_on_request',
    ...(bearer ? { userAccessToken: 'OWNER-TOKEN' } : {}),
  };
}

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

function body(call: unknown[] | undefined): Record<string, unknown> {
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
}

describe('an agent with its owner present', () => {
  it('holds BOTH sets, and says plainly whose account each one reaches', async () => {
    const tools = await buildOxyServiceTools(OWNER, agentContext({ forUser: true, self: true }));
    expect(Object.keys(tools).sort()).toEqual([
      // Ver: the owner's read only, never the send the package also lists.
      'oxy_inbox__searchEmails',
      'self_inbox__searchEmails',
      'self_inbox__sendEmail',
    ]);
    expect((tools.self_inbox__searchEmails as unknown as ExecutableTool).description)
      .toMatch(/^\[Your own Inbox\] YOUR account as this agent/);
    expect((tools.oxy_inbox__searchEmails as unknown as ExecutableTool).description)
      .toMatch(/^\[Inbox\] The PERSON you work for/);
  });

  it('gives the owner\'s writes only at Ver y actuar', async () => {
    grantAutonomy = 'autonomous';
    const tools = await buildOxyServiceTools(OWNER, agentContext({ forUser: true, self: false }));
    expect(Object.keys(tools).sort()).toEqual(['oxy_inbox__searchEmails', 'oxy_inbox__sendEmail']);
  });

  it('authorizes its own inbox with the owner\'s bearer, on the agent\'s own account', async () => {
    const tools = await buildOxyServiceTools(OWNER, agentContext({ forUser: false, self: true }));
    expect(calls('/capabilities/capability-map')).toHaveLength(0);
    await (tools.self_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hi' });
    const [created] = calls('/capabilities/execution-authorizations');
    expect(new Headers((created?.[1] as RequestInit).headers).get('authorization')).toBe('Bearer OWNER-TOKEN');
    expect(body(created)).toMatchObject({
      kind: 'direct_request',
      ownerAccountId: OWNER,
      actor: { type: 'agent', accountId: AGENT },
      resource: { appId: 'inbox', effectiveAccountId: AGENT, resourceType: 'email_account', resourceId: AGENT },
      tool: 'searchEmails',
    });
    expect(calls('/capabilities/agent-run-authorizations')).toHaveLength(0);
  });

  it('builds nothing — and asks Oxy nothing — when neither identity applies', async () => {
    const tools = await buildOxyServiceTools(OWNER, agentContext({ forUser: false, self: false }));
    expect(tools).toEqual({});
    expect(calls('/capabilities/capability-map')).toHaveLength(0);
  });
});

describe('an agent running with nobody present', () => {
  const unattended: OxyAgentIdentity = { forUser: true, self: true, unattendedSessionId: 'session-9' };

  it('authorizes each step through the agent-run lane and never names a requester', async () => {
    const tools = await buildOxyServiceTools(OWNER, agentContext(unattended, false));
    await (tools.self_inbox__sendEmail as unknown as ExecutableTool).execute({ q: 'hi' });
    await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hi' });

    const runs = calls('/capabilities/agent-run-authorizations');
    expect(runs).toHaveLength(2);
    expect(new Headers((runs[0]?.[1] as RequestInit).headers).get('authorization')).toBe('Bearer ALIA-SERVICE-TOKEN');
    expect(body(runs[0])).toMatchObject({
      actorAccountId: AGENT,
      ownerAccountId: OWNER,
      sessionId: 'session-9',
      resource: { effectiveAccountId: AGENT },
      tool: 'sendEmail',
      maximumAutonomy: 'autonomous',
    });
    expect(body(runs[1])).toMatchObject({
      resource: ownerRoot,
      tool: 'searchEmails',
      maximumAutonomy: 'read_only',
    });
    for (const run of runs) expect(body(run)).not.toHaveProperty('requesterAccountId');

    // Automation-kind authority: the run is bound when the ticket is issued.
    for (const ticket of calls('/capabilities/tickets')) {
      expect(body(ticket)).toEqual({ executionAuthorizationId: 'RUN-1', runId: 'run-1' });
    }
    expect(calls('/capabilities/execution-authorizations')).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('offers the owner\'s writes only when the grant allows unattended effects', async () => {
    grantAutonomy = 'execute_on_request';
    const onRequest = await buildOxyServiceTools(OWNER, agentContext({ ...unattended, self: false }, false));
    expect(Object.keys(onRequest)).toEqual(['oxy_inbox__searchEmails']);
    grantAutonomy = 'autonomous';
    const autonomous = await buildOxyServiceTools(OWNER, agentContext({ ...unattended, self: false }, false));
    expect(Object.keys(autonomous).sort()).toEqual(['oxy_inbox__searchEmails', 'oxy_inbox__sendEmail']);
  });
});

describe('agentIdentityPrompt', () => {
  it('is empty without Oxy app tools, and names the difference when both sets are present', () => {
    expect(agentIdentityPrompt(['getCurrentDate'])).toBe('');
    const both = agentIdentityPrompt(['self_inbox__searchEmails', 'oxy_inbox__searchEmails']);
    expect(both).toContain('YOUR OWN Oxy account');
    expect(both).toContain('the person you work for');
    expect(both).toContain('Never mix the two');
    expect(agentIdentityPrompt(['self_inbox__searchEmails'])).not.toContain('`oxy_*`');
  });
});
