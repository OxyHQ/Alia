/**
 * Who gets an agent's SYSTEM PROMPT, and who gets the rest of it.
 *
 * `GET /agents/:id` is `optionalAuth`, `findAgentById` selects every column and
 * `toAgentRecord` carries `system_prompt` — so a published agent's instructions
 * were served to anyone who asked, unauthenticated. The catalogue had always
 * withheld them (`db/__tests__/agentRepository.pgdb.test.ts` pins that), which
 * is what made the leak hard to see: one surface hid it and the other did not.
 *
 * A REAL express server with the whole `/agents` router mounted, and only Oxy
 * replaced, so the act-as rule under test is the shipped one rather than a
 * fixture's opinion of it.
 *
 * ## Every case asserts the REST of the record too
 *
 * "No prompt" is also what a 404, an empty body and a broken route produce. The
 * positive control travels with each case: the tagline is there, so the record
 * arrived and exactly one field was withheld.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PROMPT = 'you keep the roadmap honest, and this is nobody else’s business';

const state = vi.hoisted(() => ({
  account: null as null | {
    kind: string;
    relationship: string;
    callerMembership: null | { permissions: string[]; status?: string };
  },
  /** Who is calling. `undefined` is a caller with no session at all. */
  userId: undefined as string | undefined,
  accessToken: undefined as string | undefined,
  /** Every `getAccount`, so "was Oxy even asked" is assertable. */
  accountLookups: [] as string[],
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
        state.accountLookups.push(accountId);
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

/** Signs the caller in only when the case says there is one. */
function maybeSignIn(req: Request, _res: Response, next: NextFunction): void {
  const typed = req as Request & { user?: { id: string }; accessToken?: string };
  if (state.userId !== undefined) typed.user = { id: state.userId };
  typed.accessToken = state.accessToken;
  next();
}

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: maybeSignIn,
  optionalAuth: maybeSignIn,
  authenticateTokenOrApiKey: maybeSignIn,
  oxyClient: {
    getUsersByIds: async () => [
      { id: 'acct-bot', username: 'pepe', name: { displayName: 'Pepe' }, color: 'mint' },
    ],
    getProfileByUsername: async () => ({ id: 'acct-bot' }),
  },
}));

const repository = vi.hoisted(() => ({
  findAgentById: vi.fn(),
  findAgentByOxyAccountId: vi.fn(),
  findHireableAgentByOxyAccountId: vi.fn(),
  withoutSystemPrompt: undefined as unknown,
}));

vi.mock('../../../db/agents/agentRepository.js', async () => {
  const actual = await vi.importActual<typeof import('../../../db/agents/agentRepository.js')>(
    '../../../db/agents/agentRepository.js',
  );
  return {
    // The REAL omission, because that is the thing under test — a stub of it
    // would assert that the route calls something, not that the field is gone.
    withoutSystemPrompt: actual.withoutSystemPrompt,
    findAgentById: repository.findAgentById,
    findAgentByOxyAccountId: repository.findAgentByOxyAccountId,
    findHireableAgentByOxyAccountId: repository.findHireableAgentByOxyAccountId,
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

const AGENT_ROW = {
  _id: 'agent-1',
  id: 'agent-1',
  oxyAccountId: 'acct-bot',
  tagline: 'keeps the roadmap honest',
  description: 'a description',
  author: 'oxy-owner',
  category: 'research',
  tags: [],
  isPublished: true,
  access: 'public',
  status: 'active',
  systemPrompt: PROMPT,
  allowedModels: ['alia-v1'],
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
  state.accountLookups = [];
  state.userId = undefined;
  state.accessToken = undefined;
  state.account = null;
  repository.findAgentById.mockResolvedValue({ ...AGENT_ROW });
});

async function card(): Promise<{ status: number; agent: Record<string, unknown> | undefined; raw: string }> {
  const res = await fetch(`${baseUrl}/agents/agent-1`);
  const raw = await res.text();
  const body = JSON.parse(raw) as { agent?: Record<string, unknown> };
  return { status: res.status, agent: body.agent, raw };
}

/** Whoever may act as the bot account: the owner, and whoever they made an admin. */
function actingAs(userId: string): void {
  state.userId = userId;
  state.accessToken = 'token';
  state.account = {
    kind: 'bot',
    relationship: 'owner',
    callerMembership: { permissions: ['account:act_as'], status: 'active' },
  };
}

describe('the prompt on a public agent’s card', () => {
  it('is withheld from a caller with no session at all', async () => {
    const res = await card();

    expect(res.status).toBe(200);
    expect(res.agent?.systemPrompt).toBeNull();
    // The whole response, not just the field: a prompt can hide in a child list
    // or in an echo of the record somewhere else in the body.
    expect(res.raw).not.toContain(PROMPT);
    // Positive control — the record really did arrive.
    expect(res.agent?.tagline).toBe('keeps the roadmap honest');
    expect(res.agent?.name).toBe('Pepe');
  });

  it('is withheld from somebody else who is signed in', async () => {
    // The case that separates "public" from "anyone with an account". Signing
    // up is not a grant.
    state.userId = 'oxy-stranger';
    state.accessToken = 'token';
    state.account = { kind: 'bot', relationship: 'none', callerMembership: null };

    const res = await card();

    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(PROMPT);
    expect(res.agent?.tagline).toBe('keeps the roadmap honest');
  });

  it('is withheld from a member who may USE the agent', async () => {
    /**
     * The decision, written where it can be broken: sharing an agent lets
     * somebody run it, and running it is not copying it. A membership grants
     * standing — `canReachAgent` opens the thread for this caller — and
     * standing is not what unlocks the instructions. Only act-as, which is the
     * same question `PATCH /agents/:id` asks, so what the editor may read is
     * exactly what the editor may write.
     */
    state.userId = 'oxy-colleague';
    state.accessToken = 'token';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [], status: 'active' },
    };

    const res = await card();

    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(PROMPT);
    expect(res.agent?.tagline).toBe('keeps the roadmap honest');
  });

  it('is served to whoever may act as the agent’s account', async () => {
    // The editor loads what it saves. Withholding it here is what would close
    // the door with the owner inside.
    actingAs('oxy-owner');

    const res = await card();

    expect(res.status).toBe(200);
    expect(res.agent?.systemPrompt).toBe(PROMPT);
    expect(state.accountLookups).toEqual(['acct-bot']);
  });
});

describe('a draft is not addressable at all', () => {
  beforeEach(() => {
    repository.findAgentById.mockResolvedValue({ ...AGENT_ROW, isPublished: false, access: 'private' });
  });

  it('answers 404 to a stranger', async () => {
    state.userId = 'oxy-stranger';
    state.accessToken = 'token';
    state.account = { kind: 'bot', relationship: 'none', callerMembership: null };

    const res = await card();

    expect(res.status).toBe(404);
    expect(res.raw).not.toContain(PROMPT);
  });

  it('answers 404 to a member, who may use it but was not shown the draft', async () => {
    state.userId = 'oxy-colleague';
    state.accessToken = 'token';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [], status: 'active' },
    };

    expect((await card()).status).toBe(404);
  });

  it('answers it whole to whoever may act as its account', async () => {
    actingAs('oxy-owner');

    const res = await card();

    expect(res.status).toBe(200);
    expect(res.agent?.systemPrompt).toBe(PROMPT);
  });
});
