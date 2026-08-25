/**
 * `GET /agents/me` carries the last line of each thread — and asks for all of
 * them ONCE.
 *
 * The sidebar draws a row per agent with the newest message under the name. The
 * obvious way to fill that is to ask per agent, which is a query per row and
 * gets slower the more agents somebody makes — the failure that only shows up on
 * the account that uses the feature most. So the count is asserted, not the
 * shape alone: five agents, one call.
 *
 * A REAL express server with the whole `/agents` router mounted, so what is
 * measured is the route as shipped rather than a fixture's opinion of it.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'oxy-owner';

const state = vi.hoisted(() => ({
  /** Every call to the last-message query, so "how many" is assertable. */
  latestCalls: [] as { oxyUserId: string; agentIds: readonly string[] }[],
  latestRows: [] as { agentId: string; lastMessage: string | null; updatedAt: Date }[],
  owned: [] as { _id: string }[],
}));

function signIn(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user?: { id: string } }).user = { id: OWNER };
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

vi.mock('../../../db/agents/agentRepository.js', () => ({
  listAgentsByAuthor: vi.fn(async () =>
    state.owned.map((agent) => ({
      ...AGENT_SHAPE,
      _id: agent._id,
      id: agent._id,
      oxyAccountId: `acct-${agent._id}`,
    })),
  ),
  findAgentById: vi.fn(),
  findAgentByOxyAccountId: vi.fn(),
  findHireableAgentByOxyAccountId: vi.fn(),
  findAgentsByIds: vi.fn(async () => []),
  findAgentSkills: vi.fn(async () => []),
  findAgentKnowledge: vi.fn(async () => []),
  setAgentSkills: vi.fn(),
  setAgentKnowledge: vi.fn(),
  listAgentCatalogue: vi.fn(async () => ({ agents: [], total: 0 })),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  searchAgents: vi.fn(async () => []),
  listAgentsWithHeartbeat: vi.fn(async () => []),
  setAgentCatalogueFlags: vi.fn(),
  incrementAgentUsage: vi.fn(),
  withoutSystemPrompt: <T,>(agent: T) => agent,
}));

vi.mock('../../../db/chat/conversationRepository.js', () => ({
  latestMessagePerAgent: vi.fn(async (_db: unknown, oxyUserId: string, agentIds: readonly string[]) => {
    state.latestCalls.push({ oxyUserId, agentIds });
    return state.latestRows;
  }),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/logger.js', () => ({
  log: {
    agents: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

const AGENT_SHAPE = {
  tagline: 'keeps the roadmap honest',
  description: 'a description',
  author: OWNER,
  category: 'research',
  tags: [] as string[],
  isPublished: false,
  access: 'private',
  status: 'active',
  systemPrompt: 'nobody else’s business',
  allowedModels: ['alia-v1'],
  capabilityGrants: [] as string[],
  archetype: 'general',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const { default: agentsRouter } = await import('../index.js');

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
  state.latestCalls = [];
  state.latestRows = [];
  state.owned = [];
});

async function listMine(): Promise<{ agents: Record<string, unknown>[] }> {
  const response = await fetch(`${baseUrl}/agents/me`);
  expect(response.status).toBe(200);
  return (await response.json()) as { agents: Record<string, unknown>[] };
}

describe('GET /agents/me', () => {
  it('asks for every thread’s last line in ONE call, however many agents there are', async () => {
    state.owned = [{ _id: 'a1' }, { _id: 'a2' }, { _id: 'a3' }, { _id: 'a4' }, { _id: 'a5' }];

    const body = await listMine();

    // Five agents, one query. A per-agent lookup would make this five.
    expect(body.agents).toHaveLength(5);
    expect(state.latestCalls).toHaveLength(1);
    // And it asked about all of them at once, rather than about one of them.
    expect(state.latestCalls[0]?.agentIds).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('asks on the CALLER’s behalf, not the agent’s', async () => {
    // The line belongs to this person's thread with the agent. Scoped anywhere
    // else, one person reads another's conversation.
    state.owned = [{ _id: 'a1' }];

    await listMine();

    expect(state.latestCalls[0]?.oxyUserId).toBe(OWNER);
  });

  it('puts the line, and when it landed, on the agent it belongs to', async () => {
    const when = new Date('2026-08-01T12:00:00.000Z');
    state.owned = [{ _id: 'a1' }, { _id: 'a2' }];
    state.latestRows = [{ agentId: 'a2', lastMessage: 'what we said', updatedAt: when }];

    const body = await listMine();
    const byId = new Map(body.agents.map((agent) => [agent._id, agent]));

    expect(byId.get('a2')?.lastMessage).toBe('what we said');
    expect(byId.get('a2')?.lastMessageAt).toBe(when.toISOString());
    // And an agent nobody has spoken to says so explicitly rather than being
    // silently absent, which is what the row's second line renders from.
    expect(byId.get('a1')?.lastMessage).toBeNull();
    expect(byId.get('a1')?.lastMessageAt).toBeNull();
  });
});
