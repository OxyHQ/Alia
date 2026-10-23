import { registeredCatalog } from './fixtures/oxy-catalog.js';
/**
 * No Oxy app call asks the person for approval (ADR 0020 §3): a payment and a
 * deletion execute exactly like any other effect, under the authority Oxy
 * grants for the call (levels, ceilings, `finance` grants and their limits).
 * Oxy refusing the ticket is the only thing that stops one.
 *
 * The seam is `fetch`: Oxy's authority endpoints and the app itself. Every
 * assertion about "it ran" is a count of requests to the app's origin.
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
const AGENT = 'agent-bot-1';
const APP = 'https://social.example.test';

type Method = 'GET' | 'POST' | 'DELETE';
function tool(
  name: string,
  effect: 'read' | 'write' | 'external' | 'financial',
  method: Method,
  rollback: 'none' | 'manual' | 'supported',
) {
  return {
    name,
    version: '1.0.0',
    description: `${name} tool`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    capabilityPackage:
      effect === 'financial' ? 'finance' : effect === 'read' ? 'read' : 'administer',
    requiredCapabilities: [`social.${name}`],
    resourceTypes: ['social_account'],
    effect,
    idempotency: effect === 'read' ? 'none' : 'required',
    rollback,
    exposure: ['internal'],
    invocation: { method, path: `/${name}` },
    limitKeys: [],
  };
}

const CATALOG = {
  schemaVersion: '1',
  appId: 'social',
  version: '1.0.0',
  audience: 'oxy-social-api',
  internalBaseUrl: APP,
  accountResourceType: 'social_account',
  tools: [
    tool('listPosts', 'read', 'GET', 'none'),
    tool('createPost', 'external', 'POST', 'none'),
    // Trash: a write you can undo by hand. Not a deletion.
    tool('trashPost', 'write', 'POST', 'manual'),
    tool('deletePost', 'write', 'DELETE', 'none'),
    // A DELETE that is undone by its pair (`like`): not a deletion either.
    tool('unlikePost', 'external', 'DELETE', 'supported'),
    tool('payInvoice', 'financial', 'POST', 'none'),
  ],
  events: [],
};

interface ExecutableTool {
  description?: string;
  execute: (args: Record<string, unknown>, options?: { toolCallId?: string }) => Promise<unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;
let mapToolNames: string[] = [];
let appFails: 'no' | 'network' = 'no';
let ticketAllowed = true;

const personRoot = {
  appId: 'social',
  effectiveAccountId: PERSON,
  resourceType: 'social_account',
  resourceId: PERSON,
};

beforeEach(() => {
  mapToolNames = ['listPosts', 'deletePost'];
  appFails = 'no';
  ticketAllowed = true;
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token'))
      return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs'))
      return json({ registrations: [registeredCatalog(CATALOG)] });
    if (url.endsWith('/capabilities/service-identity'))
      return json({ service: { applicationId: 'alia-app', credentialId: 'alia-credential' } });
    if (url.endsWith('/capabilities/capability-map')) {
      return json({
        assignments: [
          {
            grantId: 'grant-1',
            resource: personRoot,
            maximumAutonomy: 'autonomous',
            limits: [],
            toolNames: mapToolNames,
          },
        ],
      });
    }
    if (
      url.endsWith('/capabilities/foreground-execution-authorizations') &&
      init?.method === 'POST'
    )
      return json({ authorization: { id: 'DIRECT-1' } }, 201);
    if (url.endsWith('/capabilities/tickets'))
      return ticketAllowed
        ? json({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }, 201)
        : json({ decision: { allowed: false, reason: 'limit_exceeded' } }, 201);
    if (url.startsWith(`${APP}/`)) {
      if (appFails === 'network') throw new TypeError('fetch failed: socket hang up');
      return json({ ok: true });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function appCalls() {
  return fetchMock.mock.calls.filter(([input]) => String(input).startsWith(`${APP}/`));
}

function aliaContext(): OxyToolExecutionContext {
  return {
    requesterAccountId: PERSON,
    ownerAccountId: PERSON,
    actor: { type: 'alia', ownerAccountId: PERSON },
    runId: 'run-1',
    userAccessToken: 'PERSON-TOKEN',
  };
}

function exec(tools: Record<string, unknown>, name: string) {
  const built = tools[name] as unknown as ExecutableTool | undefined;
  if (!built) throw new Error(`${name} was not built`);
  return built;
}

const APPROVAL_WORDS = /approv|review/i;

describe('Alia acting for the person', () => {
  it('runs every effect directly — a payment and a deletion included — and files nothing', async () => {
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    const names = CATALOG.tools.map((t) => t.name);
    for (const name of names) {
      const result = await exec(tools, `oxy_social__${name}`).execute({ id: 'p1' });
      // What the app answered, never a proposal or an approval error.
      expect(result).toEqual({ ok: true });
    }
    expect(appCalls()).toHaveLength(names.length);
  });

  it('a payment executes under a ticket Oxy issues for that exact call', async () => {
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    expect(await exec(tools, 'oxy_social__payInvoice').execute({ id: 'inv-1' })).toEqual({
      ok: true,
    });
    const [call] = appCalls();
    expect(String(call?.[0])).toBe(`${APP}/payInvoice`);
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
    const tickets = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/capabilities/tickets'),
    );
    expect(tickets).toHaveLength(1);
  });

  it('a payment Oxy refuses (a finance limit) does not run, and is not turned into a card', async () => {
    ticketAllowed = false;
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    const result = await exec(tools, 'oxy_social__payInvoice').execute({ id: 'inv-1' });
    expect(result).toMatchObject({ error: 'oxy_app_unavailable' });
    expect(JSON.stringify(result)).not.toMatch(APPROVAL_WORDS);
    expect(appCalls()).toHaveLength(0);
  });

  it('tells the model nothing about asking first', async () => {
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    for (const name of ['deletePost', 'payInvoice']) {
      expect(exec(tools, `oxy_social__${name}`).description ?? '').not.toMatch(APPROVAL_WORDS);
    }
  });

  it('an app that never answered is "result unknown", not a failure to retry', async () => {
    appFails = 'network';
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    expect(await exec(tools, 'oxy_social__createPost').execute({ id: 'p1' })).toMatchObject({
      error: 'oxy_app_result_unknown',
    });
  });
});

describe('an agent', () => {
  it('deletes on its own account as `self` directly', async () => {
    const tools = await buildOxyServiceTools(PERSON, {
      requesterAccountId: PERSON,
      ownerAccountId: PERSON,
      actor: { type: 'agent', accountId: AGENT },
      agentIdentity: { forUser: false, self: true },
      runId: 'run-1',
      userAccessToken: 'PERSON-TOKEN',
    });
    expect(await exec(tools, 'self_social__deletePost').execute({ id: 'p1' })).toEqual({
      ok: true,
    });
    const [call] = appCalls();
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('DELETE');
  });

  it("deletes in the person's account at Ver y actuar with no proposal", async () => {
    const tools = await buildOxyServiceTools(PERSON, {
      requesterAccountId: PERSON,
      ownerAccountId: PERSON,
      actor: { type: 'agent', accountId: AGENT },
      agentIdentity: { forUser: 'owner', self: false },
      runId: 'run-1',
      userAccessToken: 'PERSON-TOKEN',
    });
    expect(await exec(tools, 'oxy_social__deletePost').execute({ id: 'p1' })).toEqual({
      ok: true,
    });
    expect(appCalls()).toHaveLength(1);
  });
});
