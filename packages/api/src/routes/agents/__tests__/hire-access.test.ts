/**
 * `POST /agents/:id/hire` — who may hire, now that being listed is not being
 * usable.
 *
 * Hiring an agent IS using it, so the route asks the SAME question the thread
 * asks: `canReachAgent`. This file exists because a second copy of that rule is
 * the likely failure — the route used to key on `is_published`, and the cheap
 * repair would have been `access === 'public'`, which reads correct and closes
 * sharing by this door while the thread keeps it open.
 *
 * So the case that matters most here is the MEMBER against a private agent.
 *
 * A real express server with the whole `/agents` router mounted, only Oxy and
 * the session machinery replaced, so the rule under test is the shipped one.
 * The credit reservation is `hire-credit-leak.pgdb.test.ts`'s subject and is
 * stubbed out here.
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

vi.mock('@oxyhq/core', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
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

vi.mock('../../../lib/agent/session-handoff.js', () => ({ startAgentSession: session.start }));
vi.mock('../../../lib/agent/health.js', () => ({
  getAgentCapabilities: async () => ({ shell: true, browser: true }),
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

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
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
  allowedModels: ['kaana-v1'],
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
  const res = await fetch(`${baseUrl}/agents/agent-1/hire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'do the thing' }),
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

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hired: true, sessionId: 'sess-1' });
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

    expect((await hire()).status).toBe(200);
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

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hired: true });
  });

  it('is still refused when the agent is not active', async () => {
    // `access` alone is not the rule: a suspended agent is nobody's to run.
    state.agent = { ...AGENT, access: 'public', status: 'idle' };

    expect((await hire()).status).toBe(404);
  });
});
