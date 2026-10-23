import { registeredCatalog } from './fixtures/oxy-catalog.js';
/**
 * An agent's two identities (ADR 0022): the verified requester's own apps
 * (`oxy_*`) and its bot account (`self_*`). Foreground calls carry requester
 * proof; background calls retain the original task's account authority.
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

import {
  agentIdentityPrompt,
  buildOxyServiceTools,
  type OxyAgentIdentity,
  type OxyToolExecutionContext,
} from '../tools/oxy-services.js';

const OWNER = 'owner-1';
const AGENT = 'agent-bot-1';

function tool(
  name: string,
  effect: 'read' | 'external',
  capabilityPackage: string,
  method: 'GET' | 'POST',
  path: string,
) {
  return {
    name,
    version: '1.0.0',
    description: `${name} tool`,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      additionalProperties: false,
    },
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

let fetchMock: ReturnType<typeof vi.fn>;

const ownerRoot = {
  appId: 'inbox',
  effectiveAccountId: OWNER,
  resourceType: 'email_account',
  resourceId: OWNER,
};

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token'))
      return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs'))
      return json({ registrations: [registeredCatalog(CATALOG)] });
    if (url.endsWith('/capabilities/service-identity')) {
      return json({ service: { applicationId: 'alia-app', credentialId: 'alia-credential' } });
    }
    if (url.endsWith('/capabilities/capability-map')) {
      throw new Error('Own tools must not read retired app grants or levels');
    }
    if (
      url.endsWith('/capabilities/foreground-execution-authorizations') &&
      init?.method === 'POST'
    ) {
      return json({ authorization: { id: 'DIRECT-1' } }, 201);
    }
    if (url.endsWith('/capabilities/agent-run-authorizations'))
      return json({ authorization: { id: 'RUN-1' } }, 201);
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
    const tools = await buildOxyServiceTools(OWNER, agentContext({ forUser: 'owner', self: true }));
    expect(Object.keys(tools).sort()).toEqual([
      // Both accounts expose the live own tools; their execution accounts stay distinct.
      'oxy_inbox__searchEmails',
      'oxy_inbox__sendEmail',
      'self_inbox__searchEmails',
      'self_inbox__sendEmail',
    ]);
    expect((tools.self_inbox__searchEmails as unknown as ExecutableTool).description).toMatch(
      /^\[Your own Inbox\] YOUR account as this agent/,
    );
    expect((tools.oxy_inbox__searchEmails as unknown as ExecutableTool).description).toMatch(
      /^\[Inbox\] The PERSON you work for/,
    );
  });

  it("exposes the requester's own writes without app-level grants", async () => {
    const tools = await buildOxyServiceTools(
      OWNER,
      agentContext({ forUser: 'owner', self: false }),
    );
    expect(Object.keys(tools).sort()).toEqual(['oxy_inbox__searchEmails', 'oxy_inbox__sendEmail']);
    expect(calls('/capabilities/capability-map')).toHaveLength(0);
  });

  it("authorizes its own inbox with the owner's bearer, on the agent's own account", async () => {
    const tools = await buildOxyServiceTools(OWNER, agentContext({ forUser: false, self: true }));
    expect(calls('/capabilities/capability-map')).toHaveLength(0);
    await (tools.self_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hi' });
    const [created] = calls('/capabilities/foreground-execution-authorizations');
    expect(new Headers((created?.[1] as RequestInit).headers).get('authorization')).toBe(
      'Bearer ALIA-SERVICE-TOKEN',
    );
    expect(body(created)).toMatchObject({
      kind: 'direct_request',
      subjectToken: 'OWNER-TOKEN',
      authority: 'first_party',
      actor: { type: 'agent', accountId: AGENT },
      resource: {
        appId: 'inbox',
        effectiveAccountId: AGENT,
        resourceType: 'email_account',
        resourceId: AGENT,
      },
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

describe('a durable task running with nobody present', () => {
  it('authorizes children against the original task without inventing a requester bearer', async () => {
    const original = fetchMock.getMockImplementation() as (
      input: string | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith('/capabilities/tasks/task-9/execution-authorizations')
        ? Response.json({ authorization: { id: 'TASK-AUTH' } }, { status: 201 })
        : original(input, init),
    );
    const context = { ...agentContext({ forUser: 'owner', self: false }, false), taskId: 'task-9' };
    const tools = await buildOxyServiceTools(OWNER, context);
    await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hi' });
    const roots = calls('/capabilities/tasks/task-9/execution-authorizations');
    expect(roots).toHaveLength(1);
    expect(body(roots[0])).toMatchObject({
      authority: 'first_party',
      actor: { type: 'agent', accountId: AGENT },
      resource: ownerRoot,
      tool: 'searchEmails',
    });
    expect(body(roots[0])).not.toHaveProperty('subjectToken');
    expect(body(roots[0])).not.toHaveProperty('ownerAccountId');
    expect(calls('/capabilities/agent-run-authorizations')).toHaveLength(0);
  });
  it('cannot execute without a live requester or an original task', async () => {
    const tools = await buildOxyServiceTools(
      OWNER,
      agentContext({ forUser: 'owner', self: false }, false),
    );
    expect(
      await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hi' }),
    ).toMatchObject({ error: 'oxy_app_unavailable' });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://inbox.example.test/')),
    ).toBe(false);
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
