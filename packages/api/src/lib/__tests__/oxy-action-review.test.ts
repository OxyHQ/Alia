/**
 * Which Oxy app calls are reviewed — read from the catalog, never from names —
 * and how a reviewed one is re-bound and performed (docs/actors.mdx
 * "Approvals").
 *
 * The seam is `fetch`: Oxy's authority endpoints and the app itself. A
 * reviewed call that reached the app's origin is the failure this file exists
 * to catch, so every assertion about "it did not run" is a count of requests
 * to that origin.
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

import { reviewKindOf, type OxyApprovalGate } from '../agent/action-proposal.js';
import {
  buildOxyServiceTools,
  resolveReviewedOxyAction,
  type OxyToolExecutionContext,
} from '../tools/oxy-services.js';

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

const personRoot = {
  appId: 'social',
  effectiveAccountId: PERSON,
  resourceType: 'social_account',
  resourceId: PERSON,
};

beforeEach(() => {
  mapToolNames = ['listPosts', 'deletePost'];
  appFails = 'no';
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token'))
      return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs'))
      return json({ registrations: [{ catalog: CATALOG }] });
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
    if (url.endsWith('/capabilities/execution-authorizations') && init?.method === 'POST')
      return json({ authorization: { id: 'DIRECT-1' } }, 201);
    if (url.endsWith('/capabilities/tickets'))
      return json({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }, 201);
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

function aliaContext(approvals?: OxyApprovalGate): OxyToolExecutionContext {
  return {
    requesterAccountId: PERSON,
    ownerAccountId: PERSON,
    actor: { type: 'alia', ownerAccountId: PERSON },
    runId: 'run-1',
    userAccessToken: 'PERSON-TOKEN',
    ...(approvals ? { approvals } : {}),
  };
}

describe('which effects are reviewed', () => {
  it('payments and irreversible deletes, from the catalog declaration alone', () => {
    const kinds = Object.fromEntries(CATALOG.tools.map((t) => [t.name, reviewKindOf(t as never)]));
    expect(kinds).toEqual({
      listPosts: null,
      createPost: null,
      trashPost: null,
      deletePost: 'deletion',
      unlikePost: null,
      payInvoice: 'payment',
    });
  });
});

describe('Alia acting for the person', () => {
  it('reads and acts freely — no card — and files only payments and deletions', async () => {
    const propose = vi.fn<OxyApprovalGate['propose']>(async () => 'waiting for the person');
    const tools = await buildOxyServiceTools(PERSON, aliaContext({ propose }));

    for (const name of ['listPosts', 'createPost', 'trashPost', 'unlikePost']) {
      await (tools[`oxy_social__${name}`] as unknown as ExecutableTool).execute({ id: 'p1' });
    }
    expect(propose).not.toHaveBeenCalled();
    expect(appCalls()).toHaveLength(4);

    expect(
      await (tools.oxy_social__deletePost as unknown as ExecutableTool).execute({ id: 'p1' }),
    ).toBe('waiting for the person');
    expect(
      await (tools.oxy_social__payInvoice as unknown as ExecutableTool).execute({ id: 'inv-1' }),
    ).toBe('waiting for the person');
    // Neither reached the app.
    expect(appCalls()).toHaveLength(4);
    expect(propose.mock.calls.map(([p]) => p)).toEqual([
      {
        toolName: 'oxy_social__deletePost',
        appId: 'social',
        tool: 'deletePost',
        toolVersion: '1.0.0',
        kind: 'deletion',
        identity: 'for_user',
        resource: personRoot,
        args: { id: 'p1' },
      },
      expect.objectContaining({ tool: 'payInvoice', kind: 'payment', args: { id: 'inv-1' } }),
    ]);
    // The model is told up front that the tool only asks.
    expect((tools.oxy_social__deletePost as unknown as ExecutableTool).description).toMatch(
      /DELETES permanently: calling it does not delete/,
    );
  });

  it('refuses — never runs — a reviewed call on a surface with nowhere to ask', async () => {
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    expect(
      await (tools.oxy_social__deletePost as unknown as ExecutableTool).execute({ id: 'p1' }),
    ).toMatchObject({ error: 'approval_required' });
    expect(appCalls()).toHaveLength(0);
  });

  it('an app that never answered is "result unknown", not a failure to retry', async () => {
    appFails = 'network';
    const tools = await buildOxyServiceTools(PERSON, aliaContext());
    expect(
      await (tools.oxy_social__createPost as unknown as ExecutableTool).execute({ id: 'p1' }),
    ).toMatchObject({ error: 'oxy_app_result_unknown' });
  });
});

describe('an agent', () => {
  it('files a deletion on its own account as `self`', async () => {
    const propose = vi.fn<OxyApprovalGate['propose']>(async () => 'waiting');
    const tools = await buildOxyServiceTools(PERSON, {
      requesterAccountId: PERSON,
      ownerAccountId: PERSON,
      actor: { type: 'agent', accountId: AGENT },
      agentIdentity: { forUser: false, self: true },
      runId: 'run-1',
      userAccessToken: 'PERSON-TOKEN',
      approvals: { propose },
    });
    await (tools.self_social__deletePost as unknown as ExecutableTool).execute({ id: 'p1' });
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'self_social__deletePost',
        identity: 'self',
        resource: { ...personRoot, effectiveAccountId: AGENT, resourceId: AGENT },
      }),
    );
    expect(appCalls()).toHaveLength(0);
  });
});

describe('re-binding a reviewed action at decision time', () => {
  const base = {
    appId: 'social',
    tool: 'deletePost',
    resource: personRoot,
    identity: 'for_user' as const,
    args: { id: 'p1' },
    actor: { type: 'alia' as const, ownerAccountId: PERSON },
    deciderAccountId: PERSON,
    userAccessToken: 'PERSON-TOKEN',
    operationId: 'approval-1',
  };

  it('performs it once, as the decider, keyed by the approval', async () => {
    const resolved = await resolveReviewedOxyAction(base);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved).toMatchObject({ toolVersion: '1.0.0', kind: 'deletion' });
    expect(appCalls()).toHaveLength(0);
    expect(await resolved.execute()).toEqual({ status: 'succeeded', result: { ok: true } });
    const [call] = appCalls();
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('DELETE');
    const headers = new Headers(init?.headers);
    expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
    const [created] = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/capabilities/execution-authorizations'),
    );
    expect(
      new Headers((created?.[1] as RequestInit | undefined)?.headers).get('authorization'),
    ).toBe('Bearer PERSON-TOKEN');
  });

  it("refuses a resource that is not the decider's own account", async () => {
    expect(
      await resolveReviewedOxyAction({
        ...base,
        resource: { ...personRoot, effectiveAccountId: 'someone-else', resourceId: 'someone-else' },
      }),
    ).toEqual({ ok: false, reason: 'binding_changed' });
  });

  it('refuses a tool the catalog no longer has, and input it no longer accepts', async () => {
    expect(await resolveReviewedOxyAction({ ...base, tool: 'gone' })).toEqual({
      ok: false,
      reason: 'tool_gone',
    });
    expect(await resolveReviewedOxyAction({ ...base, args: { id: 1, extra: true } })).toEqual({
      ok: false,
      reason: 'input_invalid',
    });
  });

  it("refuses an agent's action once its level no longer reaches the tool", async () => {
    const agentInput = {
      ...base,
      actor: { type: 'agent' as const, accountId: AGENT },
    };
    expect((await resolveReviewedOxyAction(agentInput)).ok).toBe(true);
    mapToolNames = ['listPosts'];
    expect(await resolveReviewedOxyAction(agentInput)).toEqual({
      ok: false,
      reason: 'binding_changed',
    });
  });

  it('a request sent with no answer is outcome_unknown', async () => {
    appFails = 'network';
    const resolved = await resolveReviewedOxyAction(base);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(await resolved.execute()).toEqual({ status: 'outcome_unknown', reason: 'no_answer' });
  });
});
