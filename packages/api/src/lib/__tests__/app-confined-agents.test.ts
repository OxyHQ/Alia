import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An agent Oxy confines to an app opens only in that app (Alia ADR 0021).
 *
 * The surface is read from the REAL `verifyAppAssertion` of `@oxy.so/core`
 * against a JWKS this file serves, so a forged, foreign or mis-bound assertion
 * is refused by the same code production runs — not by a stub that agrees with
 * the test. Oxy's availability answer is the one seam: it is Oxy's fact.
 */

const oxy = vi.hoisted(() => ({
  availability: new Map<string, unknown>(),
  failing: false,
  calls: 0,
}));

vi.mock('../oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    agency: {
      agentAvailability: async (agentAccountId: string) => {
        oxy.calls += 1;
        if (oxy.failing) throw new Error('Oxy is unreachable');
        return oxy.availability.get(agentAccountId) ?? { anywhere: true };
      },
    },
  }),
}));
vi.mock('../logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});

const store = vi.hoisted(() => ({ agents: new Map<string, unknown>(), searched: [] as unknown[] }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/agentRepository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/agents/agentRepository.js')>()),
  findAgentById: async (_db: unknown, id: string) => store.agents.get(id) ?? null,
  listActiveAgentsByAuthor: async () => [],
  searchActiveAgents: async () => store.searched,
}));
const turn = vi.hoisted(() => ({ ran: [] as string[] }));
vi.mock('../tools/agent-turn.js', () => ({
  runAgentTurn: async ({ agent }: { agent: { _id: string } }) => {
    turn.ran.push(agent._id);
    return { response: 'answer', tokensUsed: 1, creditsCharged: 0 };
  },
}));
vi.mock('../agent-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-identity.js')>()),
  attachAgentIdentity: async (agent: Record<string, unknown>) => ({
    ...agent,
    name: 'Clarity',
    handle: 'claritybot',
    color: null,
  }),
}));

const { signOxyAppAssertion } = await import('@oxy.so/core/server');
const { OXY_APP_ASSERTION_AUDIENCE, OXY_APP_ASSERTION_HEADER } = await import('@oxy.so/contracts');
const { canReachAgent } = await import('../agent-account.js');
const { appSurfaceOf } = await import('../app-surface.js');
const { clearAgentAvailabilityCache } = await import('../agent-availability.js');
const { createSearchAgentsTool } = await import('../tools/agent-search.js');
const { buildConsultAgentTool } = await import('../tools/consult-agent.js');

const CLARITY_APP = 'clarity-app';
const HOMIIO_APP = 'homiio-app';
const ISSUER = 'https://api.oxy.so';
const KEY_ID = 'app-assertion-key-1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const { privateKey: strangerKey } = generateKeyPairSync('ed25519');

const PERSON = { userId: 'person-1', sessionId: 'session-1' };

const clarity = {
  _id: 'clarity-agent',
  id: 'clarity-agent',
  oxyAccountId: 'clarity-bot',
  access: 'public',
  status: 'active',
  isPublished: false,
  tagline: 'Clarity',
} as never;
const sindi = {
  _id: 'sindi-agent',
  id: 'sindi-agent',
  oxyAccountId: 'sindi-bot',
  access: 'public',
  status: 'active',
  isPublished: true,
  tagline: 'Sindi',
} as never;
const privateAgent = {
  _id: 'private-agent',
  id: 'private-agent',
  oxyAccountId: 'private-bot',
  access: 'private',
  status: 'active',
} as never;

function assertion(
  overrides: { app?: string; sub?: string; sid?: string; key?: typeof privateKey } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return signOxyAppAssertion(
    {
      iss: ISSUER,
      aud: OXY_APP_ASSERTION_AUDIENCE,
      sub: overrides.sub ?? PERSON.userId,
      sid: overrides.sid ?? PERSON.sessionId,
      app: overrides.app ?? CLARITY_APP,
      platform: 'web',
      iat: now,
      exp: now + 120,
      jti: randomUUID(),
    },
    { keyId: KEY_ID, privateKey: overrides.key ?? privateKey },
  );
}

/** A request as Oxy's middleware leaves it: a person's verified session, and maybe an assertion. */
function request(
  token: string | undefined,
  extra: Partial<Record<'serviceApp' | 'machineCredential', unknown>> = {},
): Request {
  return {
    headers: token === undefined ? {} : { [OXY_APP_ASSERTION_HEADER.toLowerCase()]: token },
    user: { id: PERSON.userId },
    sessionId: PERSON.sessionId,
    accessToken: 'person-bearer',
    ...extra,
  } as unknown as Request;
}

async function reachFrom(agent: never, req: Request) {
  return canReachAgent(agent, {
    oxyUserId: PERSON.userId,
    accessToken: 'person-bearer',
    surfaceApplicationId: await appSurfaceOf(req),
  });
}

beforeAll(() => {
  const jwk = publicKey.export({ format: 'jwk' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url) !== `${ISSUER}/capabilities/.well-known/jwks.json`)
        return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: KEY_ID, alg: 'EdDSA', use: 'sig' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  clearAgentAvailabilityCache();
  oxy.availability.clear();
  oxy.availability.set('clarity-bot', { anywhere: false, applicationIds: [CLARITY_APP] });
  oxy.failing = false;
  oxy.calls = 0;
  store.agents.clear();
  store.agents.set('clarity-agent', clarity);
  store.agents.set('sindi-agent', sindi);
  turn.ran = [];
});

describe('a confined agent opens only in its own app', () => {
  it("is reachable from its app's assertion for this session", async () => {
    expect(await reachFrom(clarity, request(assertion()))).toBe('reachable');
  });

  it("is out of reach from another app's assertion", async () => {
    expect(await reachFrom(clarity, request(assertion({ app: HOMIIO_APP })))).toBe('out_of_reach');
  });

  it('is out of reach with no assertion at all', async () => {
    expect(await reachFrom(clarity, request(undefined))).toBe('out_of_reach');
  });

  it('is out of reach with an assertion that does not verify', async () => {
    expect(await reachFrom(clarity, request('not.an.assertion'))).toBe('out_of_reach');
    expect(await reachFrom(clarity, request(assertion({ key: strangerKey })))).toBe('out_of_reach');
  });

  it("is out of reach with another session's or another person's assertion", async () => {
    expect(await reachFrom(clarity, request(assertion({ sid: 'session-2' })))).toBe('out_of_reach');
    expect(await reachFrom(clarity, request(assertion({ sub: 'person-2' })))).toBe('out_of_reach');
  });

  it('is out of reach from a service token or a machine key, whatever they carry', async () => {
    const token = assertion();
    expect(await reachFrom(clarity, request(token, { serviceApp: { appId: CLARITY_APP } }))).toBe(
      'out_of_reach',
    );
    expect(await reachFrom(clarity, request(token, { machineCredential: {} }))).toBe(
      'out_of_reach',
    );
  });

  it('is never reachable when Oxy cannot say where it opens', async () => {
    oxy.failing = true;
    expect(await reachFrom(clarity, request(assertion()))).toBe('identity_unavailable');
    expect(await reachFrom(sindi, request(undefined))).toBe('identity_unavailable');
  });
});

describe('an unconfined agent is unaffected', () => {
  it('opens from any app and from none', async () => {
    expect(await reachFrom(sindi, request(undefined))).toBe('reachable');
    expect(await reachFrom(sindi, request(assertion({ app: HOMIIO_APP })))).toBe('reachable');
    expect(await reachFrom(sindi, request(assertion()))).toBe('reachable');
  });

  it('asks Oxy once a minute, not once a request', async () => {
    await reachFrom(sindi, request(undefined));
    await reachFrom(sindi, request(undefined));
    expect(oxy.calls).toBe(1);
  });

  it('never asks where an agent opens when WHO already said no', async () => {
    const reach = await canReachAgent(privateAgent, {
      oxyUserId: PERSON.userId,
      accessToken: undefined,
      surfaceApplicationId: CLARITY_APP,
    });
    expect(reach).toBe('out_of_reach');
    expect(oxy.calls).toBe(0);
  });
});

describe('the surface is read once per request', () => {
  it('answers the same promise for the same request', async () => {
    const req = request(assertion());
    expect(appSurfaceOf(req)).toBe(appSurfaceOf(req));
    expect(await appSurfaceOf(req)).toBe(CLARITY_APP);
  });
});

describe('searchAgents offers only agents that open where the person is', () => {
  beforeEach(() => {
    store.searched = [
      { id: 'clarity-agent', oxyAccountId: 'clarity-bot', tagline: 'Clarity' },
      { id: 'sindi-agent', oxyAccountId: 'sindi-bot', tagline: 'Sindi' },
    ];
  });

  async function search(surface: string | null) {
    const tool = createSearchAgentsTool(surface);
    const result = (await tool.execute?.({ query: 'help' }, { toolCallId: 't', messages: [] })) as {
      agents: Array<{ id: string }>;
    };
    return result.agents.map((agent) => agent.id);
  }

  it('leaves a confined agent out outside its app', async () => {
    expect(await search(null)).toEqual(['sindi-agent']);
    expect(await search(HOMIIO_APP)).toEqual(['sindi-agent']);
  });

  it('offers it inside its app', async () => {
    expect(await search(CLARITY_APP)).toEqual(['clarity-agent', 'sindi-agent']);
  });
});

describe('consultAgent refuses a confined agent outside its app', () => {
  async function consult(surface: string | null) {
    const tools = await buildConsultAgentTool({
      person: {
        oxyUserId: PERSON.userId,
        accessToken: 'person-bearer',
        isDirectSession: true,
        surfaceApplicationId: surface,
      },
      payerOxyUserId: PERSON.userId,
      callerAgentId: null,
    });
    return (await tools.consultAgent.execute?.(
      { agentId: 'clarity-agent', task: 'help' },
      { toolCallId: 't', messages: [] },
    )) as { error?: string; response: string };
  }

  it('answers "not found" and runs nothing from another app', async () => {
    const result = await consult(HOMIIO_APP);
    expect(result.error).toBe('Agent not found');
    expect(turn.ran).toEqual([]);
  });

  it('answers "not found" and runs nothing with no app', async () => {
    expect((await consult(null)).error).toBe('Agent not found');
    expect(turn.ran).toEqual([]);
  });

  it('consults it from its own app', async () => {
    const result = await consult(CLARITY_APP);
    expect(result.error).toBeUndefined();
    expect(turn.ran).toEqual(['clarity-agent']);
  });
});
