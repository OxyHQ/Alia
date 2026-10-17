/**
 * An app's feature tools (ADR 0020 §6) are called on exactly the binding the
 * person's lane gives the model — the ceiling's for somebody who is not the
 * owner — through the same ticket path as any `oxy_*` call, and a spend carries
 * the caller's own idempotency key rather than one derived from the run.
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
  callOxyFeatureTool,
  findOxyAppFeature,
  presentPersonAgentContext,
} from '../tools/oxy-services.js';

const PERSON = 'person-1';
const OWNER = 'owner-1';
const AGENT = 'sindi-bot';

function tool(
  name: string,
  effect: 'read' | 'write',
  options: { exposure?: string[]; idempotency?: string; input?: Record<string, unknown> } = {},
) {
  return {
    name,
    version: '1.0.0',
    description: `${name} tool`,
    inputSchema: {
      type: 'object',
      properties: options.input ?? {},
      ...(options.input ? { required: Object.keys(options.input) } : {}),
      additionalProperties: false,
    },
    capabilityPackage: effect === 'read' ? 'read' : 'create',
    requiredCapabilities: [`homiio.${name}`],
    resourceTypes: ['homiio_account'],
    effect,
    idempotency: options.idempotency ?? (effect === 'read' ? 'none' : 'required'),
    rollback: 'none',
    exposure: options.exposure ?? ['internal'],
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
  features: [
    {
      key: 'files',
      description: 'Homiio+ documents',
      checkTool: 'readFileEntitlement',
      consumeTool: 'consumeFileCredit',
    },
    {
      key: 'reports',
      description: 'Takes an input Alia never sends',
      checkTool: 'readReportEntitlement',
    },
  ],
  tools: [
    tool('readFileEntitlement', 'read'),
    tool('consumeFileCredit', 'write'),
    tool('readReportEntitlement', 'read', { input: { region: { type: 'string' } } }),
  ],
  events: [],
};

const personRoot = {
  appId: 'homiio',
  effectiveAccountId: PERSON,
  resourceType: 'homiio_account',
  resourceId: PERSON,
};

let ceilingTools: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Oxy and the app, as this file's fake network answers them. */
async function respond(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (url.endsWith('/auth/service-token'))
    return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
  if (url.endsWith('/capabilities/catalogs'))
    return json({ registrations: [{ catalog: CATALOG }] });
  if (url.endsWith('/capabilities/service-identity'))
    return json({ service: { applicationId: 'alia-app', credentialId: 'alia-credential' } });
  if (url.endsWith('/capabilities/requester-capability-map')) {
    return json({
      assignments: [
        {
          ceilingId: 'ceiling-1',
          resource: personRoot,
          maximumAutonomy: 'autonomous',
          limits: [],
          toolNames: ceilingTools,
        },
      ],
    });
  }
  if (url.endsWith('/capabilities/capability-map'))
    throw new Error('the owner-grant map must never be asked for a non-owner');
  if (url.endsWith('/capabilities/execution-authorizations') && init?.method === 'POST')
    return json({ authorization: { id: 'DIRECT-1' } }, 201);
  if (url.endsWith('/capabilities/tickets'))
    return json({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }, 201);
  if (url === 'https://homiio.example.test/readFileEntitlement')
    return json({ available: true, remaining: 2 });
  if (url === 'https://homiio.example.test/consumeFileCredit')
    return json({ consumed: true, remaining: 1 });
  if (init?.method === 'DELETE') return new Response(null, { status: 204 });
  return new Response('not found', { status: 404 });
}

beforeEach(() => {
  ceilingTools = ['readFileEntitlement', 'consumeFileCredit'];
  fetchMock = vi.fn(respond);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const lane = () => {
  const context = presentPersonAgentContext({
    agent: { oxyAccountId: AGENT, ownerOxyAccountId: OWNER },
    personAccountId: PERSON,
    accessToken: 'PERSON-TOKEN',
    runId: 'run-1',
  });
  if (context === null) throw new Error('expected a lane');
  return context;
};

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

/** The `RequestInit` of the first request sent to `suffix`. */
function sent(suffix: string): RequestInit {
  const call = calls(suffix)[0];
  if (!call) throw new Error(`Expected a request to ${suffix}`);
  return call[1] as RequestInit;
}

describe('the lane a feature tool runs on', () => {
  it('is the requester ceiling for somebody who is not the owner, and the levels for the owner', () => {
    expect(lane().agentIdentity).toEqual({ forUser: 'requester', self: false });
    expect(
      presentPersonAgentContext({
        agent: { oxyAccountId: AGENT, ownerOxyAccountId: OWNER },
        personAccountId: OWNER,
        accessToken: 'OWNER-TOKEN',
        runId: 'run-1',
      })?.agentIdentity,
    ).toEqual({ forUser: 'owner', self: false });
    // No reconciled owner: no lane at all, as for its `oxy_*` tools.
    expect(
      presentPersonAgentContext({
        agent: { oxyAccountId: AGENT, ownerOxyAccountId: null },
        personAccountId: PERSON,
        accessToken: 'PERSON-TOKEN',
        runId: 'run-1',
      }),
    ).toBeNull();
  });
});

describe('callOxyFeatureTool', () => {
  it("asks the app on the person's own account, as the person's direct request under the ceiling", async () => {
    const answer = await callOxyFeatureTool(lane(), 'homiio', 'readFileEntitlement');
    expect(answer).toEqual({ status: 'answered', result: { available: true, remaining: 2 } });
    expect(JSON.parse(String(sent('/capabilities/execution-authorizations').body))).toMatchObject({
      kind: 'direct_request',
      resource: personRoot,
      tool: 'readFileEntitlement',
      ceilingId: 'ceiling-1',
    });
    expect(sent('/readFileEntitlement').headers).toMatchObject({
      authorization: 'Capability SHORT-TICKET',
    });
  });

  it('spends under the idempotency key it is given, not one derived from the run', async () => {
    await callOxyFeatureTool(lane(), 'homiio', 'consumeFileCredit', 'PART-KEY');
    expect(sent('/consumeFileCredit').headers).toMatchObject({ 'idempotency-key': 'PART-KEY' });
  });

  it('is unbound when the ceiling does not reach the tool', async () => {
    ceilingTools = ['readFileEntitlement'];
    expect(await callOxyFeatureTool(lane(), 'homiio', 'consumeFileCredit', 'K')).toEqual({
      status: 'unbound',
    });
    expect(calls('/consumeFileCredit')).toHaveLength(0);
  });

  it('is unavailable, not a verdict, when Oxy refuses the authority', async () => {
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith('/capabilities/tickets')
        ? new Response('no', { status: 403 })
        : respond(input, init),
    );
    expect(await callOxyFeatureTool(lane(), 'homiio', 'readFileEntitlement')).toEqual({
      status: 'unavailable',
    });
  });
});

describe('a project-owned agent opened by its own project account', () => {
  it('is unbound — locked — when Oxy refuses the owner lane, never unavailable', async () => {
    // The owner lane is the turn's lane, and Oxy never lets a project account
    // operate itself (only a personal account does): a verdict, not an outage.
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith('/capabilities/capability-map')
        ? Response.json({ error: 'requester_lacks_grant_owner_authority' }, { status: 403 })
        : respond(input, init),
    );
    const ownerLane = presentPersonAgentContext({
      agent: { oxyAccountId: AGENT, ownerOxyAccountId: OWNER },
      personAccountId: OWNER,
      accessToken: 'PROJECT-TOKEN',
      runId: 'run-1',
    });
    if (ownerLane === null) throw new Error('expected a lane');
    expect(await callOxyFeatureTool(ownerLane, 'homiio', 'readFileEntitlement')).toEqual({
      status: 'unbound',
    });
    expect(calls('/readFileEntitlement')).toHaveLength(0);
  });

  it('is still unavailable when Oxy cannot answer at all', async () => {
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith('/capabilities/capability-map')
        ? new Response('down', { status: 503 })
        : respond(input, init),
    );
    const ownerLane = presentPersonAgentContext({
      agent: { oxyAccountId: AGENT, ownerOxyAccountId: OWNER },
      personAccountId: OWNER,
      accessToken: 'PROJECT-TOKEN',
      runId: 'run-1',
    });
    if (ownerLane === null) throw new Error('expected a lane');
    expect(await callOxyFeatureTool(ownerLane, 'homiio', 'readFileEntitlement')).toEqual({
      status: 'unavailable',
    });
  });
});

describe('findOxyAppFeature', () => {
  it('reads a declared feature from the live catalogue', async () => {
    expect(await findOxyAppFeature('homiio', 'files')).toMatchObject({
      feature: { checkTool: 'readFileEntitlement', consumeTool: 'consumeFileCredit' },
      toolsTakeNoInput: true,
    });
  });

  it('says when a feature tool needs an input Alia never sends', async () => {
    expect(await findOxyAppFeature('homiio', 'reports')).toMatchObject({ toolsTakeNoInput: false });
  });

  it('is null for a feature or an app that is not declared', async () => {
    expect(await findOxyAppFeature('homiio', 'nothing')).toBeNull();
    expect(await findOxyAppFeature('inbox', 'files')).toBeNull();
  });
});
