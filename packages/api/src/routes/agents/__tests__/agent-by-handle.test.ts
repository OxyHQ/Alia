/**
 * `GET /agents/handle/:username`: the agent card for the agent whose Oxy handle this is, with the
 * rules of `GET /agents/:id` (they share `respondWithAgent`), because the address of an agent is
 * its handle and `/@username/details` and `/@username/edit` read it.
 *
 * (The prompt rules below are `agent-prompt-visibility.test.ts`'s; `GET /agents/:id` is `optionalAuth`, `findAgentById` selects every column and
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

// Where an agent opens (ADR 0021) is `app-confined-agents.test.ts`'s subject, not this file's.
vi.mock('../../../lib/agent-availability.js', () => ({ agentOpensOn: async () => 'reachable' }));
vi.mock('@oxy.so/core', async () => {
  const actual = await vi.importActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    ...actual,
    OxyServices: class {
      session = { setAccessToken: (...args: any[]) => (this as any).setTokens(...args) };
      accounts = { get: (...args: any[]) => (this as any).getAccount(...args) };
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        state.accountLookups.push(accountId);
        if (state.account === null) throw new NotFound('no such account');
        return {
          accountId,
          parentAccountId: 'oxy-owner',
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
}));
vi.mock('../../../lib/oxy.js', async () => {
  const { OxyServices } = await import('@oxy.so/core');
  const { fakeWithUser } = await import('../../../__tests__/mocks/oxy-user-client.js');
  const userClient = () => new OxyServices({ baseURL: 'https://api.oxy.test' });
  return {
    oxy: {
      withUser: fakeWithUser(userClient),
      // `lib/socket-session-auth.ts` builds its handshake verifier at import.
      middleware: { socket: () => () => undefined },
      users: {
        lookupMany: async () => ({
          found: [
            { id: 'acct-bot', username: 'pepe', name: { displayName: 'Pepe' }, color: 'mint' },
          ],
          missing: [],
          failed: [],
        }),
        byUsername: async () => ({ id: 'acct-bot' }),
      },
    },
  };
});

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
    withoutInternalAgentBindings: actual.withoutInternalAgentBindings,
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
  ownerOxyAccountId: 'oxy-owner',
  tagline: 'keeps the roadmap honest',
  description: 'a description',
  author: 'oxy-owner',
  category: 'research',
  tags: [],
  isPublished: true,
  access: 'public',
  status: 'active',
  systemPrompt: PROMPT,
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

async function byHandle(handle: string): Promise<{
  status: number;
  agent: Record<string, unknown> | undefined;
  raw: string;
}> {
  const res = await fetch(`${baseUrl}/agents/handle/${handle}`);
  const raw = await res.text();
  const body = JSON.parse(raw) as { agent?: Record<string, unknown> };
  return { status: res.status, agent: body.agent, raw };
}

describe('GET /agents/handle/:username', () => {
  beforeEach(() => {
    // The handle resolves to the bot account (`oxy.users.byUsername`), and the account to the row.
    repository.findAgentByOxyAccountId.mockResolvedValue({ ...AGENT_ROW });
  });

  it('is the agent’s card, found by handle, with no prompt for a stranger', async () => {
    const res = await byHandle('pepe');
    expect(res.status).toBe(200);
    expect(res.agent?.tagline).toBe('keeps the roadmap honest');
    expect(res.agent?.name).toBe('Pepe');
    expect(res.raw).not.toContain(PROMPT);
    expect(repository.findAgentById).toHaveBeenCalledWith(expect.anything(), 'agent-1');
  });

  it('accepts the handle as people write it, with its @', async () => {
    expect((await byHandle('%40pepe')).status).toBe(200);
  });

  it('is the same 404 for a handle that is no agent', async () => {
    repository.findAgentByOxyAccountId.mockResolvedValue(null);
    const res = await byHandle('nobody');
    expect(res.status).toBe(404);
    expect(res.raw).toBe(JSON.stringify({ error: 'Agent not found' }));
  });

  it('is that same 404 for a draft nobody may edit: it reveals nothing about it', async () => {
    repository.findAgentById.mockResolvedValue({ ...AGENT_ROW, isPublished: false });
    const res = await byHandle('pepe');
    expect(res.status).toBe(404);
    expect(res.raw).toBe(JSON.stringify({ error: 'Agent not found' }));
  });

  it('gives whoever may edit the agent its prompt, as `GET /agents/:id` does', async () => {
    state.userId = 'oxy-owner';
    state.accessToken = 'token';
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'], status: 'active' },
    };
    const res = await byHandle('pepe');
    expect(res.status).toBe(200);
    expect(res.agent?.systemPrompt).toBe(PROMPT);
  });
});
