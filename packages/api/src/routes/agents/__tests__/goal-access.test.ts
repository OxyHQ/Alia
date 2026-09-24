/**
 * `POST /agents/threads/:threadId/goals` — who may hire, now that being listed
 * is not being usable.
 *
 * A goal is the paid hire: `POST /agents/:id/hire` was retired and this is the
 * route the app hires through. Hiring an agent IS using it, so the route asks
 * the SAME question the thread asks: `canReachAgent`, again at goal time — a
 * thread opened while somebody could reach the agent must not outlive a revoked
 * membership as a way to keep spending on it.
 *
 * A second copy of that rule is the likely failure — the old hire route keyed
 * on `is_published`, and the cheap repair would have been `access === 'public'`,
 * which reads correct and closes sharing by this door while the thread keeps it
 * open. So the case that matters most here is the MEMBER against a private
 * agent.
 *
 * A real express server with the whole `/agents` router mounted, only Oxy, the
 * runtime repository and the session machinery replaced, so the rule under test
 * is the shipped one. The credit reservation is
 * `goal-credit-leak.pgdb.test.ts`'s subject and is stubbed out here.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  account: null as null | {
    kind: string;
    relationship: string;
    callerMembership: null | { permissions: string[]; status?: string };
  },
  userId: 'oxy-caller' as string | undefined,
  accessToken: 'token' as string | undefined,
  agent: {} as Record<string, unknown>,
}));

class NotFound extends Error {
  status = 404;
}

vi.mock('@oxy.so/core', async () => {
  const actual = await vi.importActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        if (state.account === null) throw new NotFound('no such account');
        return {
          accountId,
          kind: state.account.kind,
          relationship: state.account.relationship,
          account: { id: accountId, kind: state.account.kind },
          callerMembership: state.account.callerMembership,
        };
      }
    },
  };
});

function signIn(req: Request, _res: Response, next: NextFunction): void {
  const typed = req as Request & { user?: { id: string }; accessToken?: string };
  if (state.userId !== undefined) typed.user = { id: state.userId };
  typed.accessToken = state.accessToken;
  next();
}

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: signIn,
  optionalAuth: signIn,
  authenticateTokenOrApiKey: signIn,
  oxyClient: {
    getUsersByIds: async () => [],
    getProfileByUsername: async () => ({ id: 'acct-bot' }),
  },
}));

const session = vi.hoisted(() => ({
  start: vi.fn(async () => ({ ok: true, sessionId: 'sess-1', queued: true, jobId: 'job-1' })),
}));

vi.mock('../../../lib/agent/session-handoff.js', () => ({
  startAgentSession: session.start,
  agentHirePrice: (agent: { price: number | null }) => agent.price || 15,
}));

/** The caller's own open thread with the agent — what a goal is started on. */
const THREAD = {
  id: 'thread-1',
  oxyUserId: 'oxy-caller',
  agentId: 'agent-1',
  status: 'open',
};

vi.mock('../../../db/agents/agentRuntimeRepository.js', () => ({
  findAgentThread: vi.fn(async (_db: unknown, oxyUserId: string) => (
    oxyUserId === state.userId ? { ...THREAD, oxyUserId } : undefined
  )),
  createAgentGoal: vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({
    goal: { id: 'goal-1', status: 'active', ...input },
    created: true,
  })),
  withAgentAdmission: vi.fn(async (_db: unknown, _agentId: string, _max: number, callback: () => Promise<unknown>) => ({
    admitted: true,
    value: await callback(),
  })),
  createAgentThread: vi.fn(),
  listAgentThreads: vi.fn(async () => []),
  updateAgentThread: vi.fn(),
  verifyAgentGoal: vi.fn(),
}));

vi.mock('../../../db/agents/agentRepository.js', async () => {
  const actual = await vi.importActual<typeof import('../../../db/agents/agentRepository.js')>(
    '../../../db/agents/agentRepository.js',
  );
  return {
    withoutSystemPrompt: actual.withoutSystemPrompt,
    findAgentById: vi.fn(async () => state.agent),
    findAgentByOxyAccountId: vi.fn(async () => null),
    findHireableAgentByOxyAccountId: vi.fn(async () => null),
    findAgentsByIds: vi.fn(async () => []),
    findAgentSkills: vi.fn(async () => []),
    findAgentKnowledge: vi.fn(async () => []),
    setAgentSkills: vi.fn(),
    setAgentKnowledge: vi.fn(),
    listAgentCatalogue: vi.fn(async () => ({ agents: [], total: 0 })),
    listAgentsByAuthor: vi.fn(async () => []),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    searchAgents: vi.fn(async () => []),
    listAgentsWithHeartbeat: vi.fn(async () => []),
    setAgentCatalogueFlags: vi.fn(),
    incrementAgentUsage: vi.fn(),
  };
});

/**
 * The route links the started session to its goal with one UPDATE. A chain that
 * accepts it is all this file needs of a database.
 */
vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['update', 'set', 'where', 'select', 'from', 'limit']) chain[method] = () => chain;
  (chain as { then: unknown }).then = (resolve: (value: unknown[]) => unknown) => resolve([]);
  return { getDb: () => chain };
});
vi.mock('../../../lib/logger.js', () => ({
  log: {
    agents: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

const { default: agentsRouter } = await import('../index.js');
const { clearAgentAccountVerdicts } = await import('../../../lib/agent-account.js');

const AGENT = {
  _id: 'agent-1',
  id: 'agent-1',
  oxyAccountId: 'acct-bot',
  tagline: 'runs things',
  description: 'd',
  author: 'oxy-owner',
  category: 'research',
  tags: [],
  isPublished: true,
  access: 'private',
  status: 'active',
  price: 15,
  systemPrompt: 'p',
  capabilityGrants: [],
  archetype: 'general',
  createdAt: new Date(),
  updatedAt: new Date(),
};

let app: Express;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use('/agents', agentsRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentAccountVerdicts();
  session.start.mockResolvedValue({ ok: true, sessionId: 'sess-1', queued: true, jobId: 'job-1' });
  state.userId = 'oxy-caller';
  state.accessToken = 'token';
  state.account = null;
  state.agent = { ...AGENT };
});

async function hire(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/agents/threads/thread-1/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${Math.random()}` },
    body: JSON.stringify({ objective: 'do the thing' }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('hiring a PRIVATE agent', () => {
  it('is refused to a stranger, and starts nothing', async () => {
    // `is_published` is true here on purpose: it is in the catalogue, and that
    // is no longer a licence to run it.
    const res = await hire();

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Agent not found' });
    // The half a status code does not prove: no session, so no reservation.
    expect(session.start).not.toHaveBeenCalled();
  });

  it('works for somebody with a MEMBERSHIP on the bot account', async () => {
    /**
     * The case this file exists for. Private means "its owner and whoever was
     * added to its account", and sharing an agent IS that membership — so
     * hiring has to honour it. A route that asked `access === 'public'` would
     * read correct, pass every other case here, and close sharing by this door
     * while the thread kept it open.
     *
     * Note the permissions: EMPTY. This member cannot act as the account, and
     * still may hire.
     */
    state.userId = 'oxy-colleague';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [], status: 'active' },
    };

    const res = await hire();

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ sessionId: 'sess-1' });
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  it('works for its owner', async () => {
    // Hiring your own agent cannot depend on having published it.
    state.userId = 'oxy-owner';
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'], status: 'active' },
    };
    state.agent = { ...AGENT, isPublished: false };

    expect((await hire()).status).toBe(202);
  });

  it('is refused to somebody whose membership is not active yet', async () => {
    state.userId = 'oxy-invited';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [], status: 'invited' },
    };

    expect((await hire()).status).toBe(404);
  });
});

describe('hiring a PUBLIC agent', () => {
  beforeEach(() => {
    state.agent = { ...AGENT, access: 'public' };
  });

  it('works for a stranger, and asks Oxy nothing', async () => {
    const res = await hire();

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ sessionId: 'sess-1' });
  });

  it('is still refused when the agent is not active', async () => {
    // `access` alone is not the rule: a suspended agent is nobody's to run.
    state.agent = { ...AGENT, access: 'public', status: 'idle' };

    expect((await hire()).status).toBe(404);
  });
});

describe('the retired hire route', () => {
  it('is not mounted: a hire is a goal on a thread, and nothing else starts one', async () => {
    // `POST /agents/:id/hire` answered 503 in production for its whole life —
    // it refused unless a sandbox or a browser existed, and neither did — and no
    // client called it. Its absence is the decision; a stub would be a second
    // door to the same reservation.
    state.agent = { ...AGENT, access: 'public' };
    const res = await fetch(`${baseUrl}/agents/agent-1/hire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'do the thing' }),
    });

    expect(res.status).toBe(404);
    expect(session.start).not.toHaveBeenCalled();
    // The control: the same agent IS hireable through the live route.
    expect((await hire()).status).toBe(202);
  });

  it('took GET /agents/health with it', async () => {
    // It reported `shell: false, browser: false` forever. `health` now reads as
    // an agent id, which does not exist.
    const res = await fetch(`${baseUrl}/agents/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('capabilities');
  });
});
