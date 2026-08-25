/**
 * `GET /agents/thread/:username` — who may open a thread, and what a refusal says.
 *
 * A REAL express server with the WHOLE `/agents` router mounted, because two of
 * the properties under test belong to express rather than to the handler: the
 * status code a client branches on, and that a handle like `@activity` reaches
 * this route rather than `/:id/activity` with the id read as the word `thread`.
 *
 * Only OXY is replaced. `lib/agent-account.ts` runs for real — including
 * `canSwitchIntoAccount` from `@oxyhq/core`, imported through `importActual` —
 * so what these assert is the SHIPPED act-as rule, not a fixture's opinion of
 * it. The repository is a spy: what matters here is which pair it was asked
 * for, and `db/__tests__/agentThread.pgdb.test.ts` covers what it then does.
 *
 * ## The assertion that matters most is about the BODY, not the status
 *
 * A stranger against an unpublished agent gets 404, and the body must be the
 * same one a nonexistent handle gets. A 403 — or a 404 whose message says
 * "not published" — answers a question the caller has no right to ask: whether
 * that handle belongs to somebody's draft agent. Handles are guessable, which
 * is the whole reason this route cannot afford the distinction that every
 * id-addressed agent route can.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** `null` makes `getAccount` reject with a 404, as Oxy does for an unseen account. */
  account: null as null | {
    kind: string;
    relationship: string;
    callerMembership: null | { permissions: string[]; status?: string };
  },
  /** `true` makes `getAccount` reject with a transport failure, not a 404. */
  unreachable: false,
  /** Every `getAccount` call, so "was Oxy even asked" is assertable. */
  accountLookups: [] as string[],
  /** `null` makes `getProfileByUsername` reject: no such handle anywhere in Oxy. */
  profile: { id: 'acct-bot' } as null | { id: string },
  /** What `POST /users/by-ids` resolves. Empty means Oxy resolved nothing. */
  users: [] as { id: string; username: string; name: { displayName?: string }; color?: string }[],
  userId: 'oxy-caller',
  accessToken: 'token-abc' as string | undefined,
}));

class NotFound extends Error {
  status = 404;
}
class Unreachable extends Error {
  status = 503;
}

vi.mock('@oxyhq/core', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        state.accountLookups.push(accountId);
        if (state.unreachable) throw new Unreachable('oxy is down');
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
  typed.user = { id: state.userId };
  typed.accessToken = state.accessToken;
  next();
}

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: signIn,
  // The WHOLE `/agents` router is mounted below, so every middleware any
  // sub-router imports has to exist here — that is the cost of asserting the
  // mount ORDER rather than restating it.
  optionalAuth: signIn,
  authenticateTokenOrApiKey: signIn,
  oxyClient: {
    getUsersByIds: async () => state.users,
    getProfileByUsername: async () => {
      if (state.profile === null) throw new NotFound('no such username');
      return state.profile;
    },
  },
}));

const repository = vi.hoisted(() => ({
  findAgentByOxyAccountId: vi.fn(),
  findHireableAgentByOxyAccountId: vi.fn(),
  findAgentById: vi.fn(),
}));
vi.mock('../../../db/agents/agentRepository.js', () => repository);

const threads = vi.hoisted(() => ({
  findActiveThreadConversation: vi.fn(),
  createConversation: vi.fn(),
}));
vi.mock('../../../db/chat/conversationRepository.js', () => threads);

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
  tagline: 'finds things out',
  description: 'a description',
  author: 'oxy-owner',
  category: 'research',
  tags: [],
  isPublished: false,
  /** A draft, and private — which is what a new agent is. */
  access: 'private',
  status: 'active',
  systemPrompt: 'a prompt nobody else may read',
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
  state.unreachable = false;
  state.accountLookups = [];
  state.userId = 'oxy-caller';
  state.accessToken = 'token-abc';
  state.profile = { id: 'acct-bot' };
  state.users = [
    { id: 'acct-bot', username: 'pepe', name: { displayName: 'Pepe' }, color: 'lagoon' },
  ];
  // The default is the hardest case: an UNPUBLISHED agent, and a caller who
  // holds nothing on its account.
  state.account = { kind: 'bot', relationship: 'none', callerMembership: null };
  repository.findAgentByOxyAccountId.mockResolvedValue(AGENT_ROW);
  repository.findHireableAgentByOxyAccountId.mockResolvedValue(AGENT_ROW);
  threads.findActiveThreadConversation.mockResolvedValue({ conversationId: 'conv-1' });
  threads.createConversation.mockResolvedValue({ conversationId: 'conv-new' });
});

async function thread(username = 'pepe'): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/agents/thread/${username}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The body a caller who cannot reach an agent must see, whatever the reason. */
const NOT_FOUND_BODY = { error: 'Agent not found' };

describe('the route is reachable, and resolves the pair', () => {
  it('answers the agent and a conversation for its owner', async () => {
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };

    const res = await thread();

    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe('conv-1');
    expect(res.body.agent).toEqual({
      _id: 'agent-1',
      name: 'Pepe',
      handle: 'pepe',
      color: 'lagoon',
      tagline: 'finds things out',
      description: 'a description',
    });
  });

  it('asks for the thread of the CALLER and this agent, not of the agent alone', async () => {
    state.userId = 'oxy-somebody-else';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: ['account:act_as'] },
    };

    await thread();

    expect(threads.findActiveThreadConversation).toHaveBeenCalledTimes(1);
    const [, oxyUserId, agentId] = threads.findActiveThreadConversation.mock.calls[0];
    expect(oxyUserId).toBe('oxy-somebody-else');
    expect(agentId).toBe('agent-1');
  });

  /**
   * A thread is MANY conversations, so "open it" continues the newest stretch.
   * It creates one only when the two have never spoken — and a route that
   * created one every time would bury the history it was asked to continue.
   */
  it('continues the ACTIVE conversation rather than starting another', async () => {
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };

    const res = await thread();

    expect(res.body.conversationId).toBe('conv-1');
    expect(threads.createConversation).not.toHaveBeenCalled();
  });

  it('starts one only when the two have never spoken', async () => {
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };
    threads.findActiveThreadConversation.mockResolvedValue(undefined);

    const res = await thread();

    expect(res.body.conversationId).toBe('conv-new');
    expect(threads.createConversation).toHaveBeenCalledTimes(1);
    // Carrying the agent, or the new conversation is not part of the thread at
    // all and the next open would start yet another.
    const input = threads.createConversation.mock.calls[0][1] as Record<string, unknown>;
    expect(input.agentId).toBe('agent-1');
    expect(input.oxyUserId).toBe('oxy-caller');
  });

  it('serves a handle that collides with a route segment', async () => {
    /**
     * `@activity` is a handle somebody may hold, and `/agents/thread/activity`
     * matches `/:id/activity` EXACTLY, with the id read as the word `thread`.
     * Which one answers is decided by mount order in `agents/index.ts` and by
     * nothing else — measured: move `threadRouter` after `activityRouter` and
     * this goes red while every other case here stays green.
     */
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };
    state.users = [
      { id: 'acct-bot', username: 'activity', name: { displayName: 'Activity' } },
    ];

    const res = await thread('activity');

    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe('conv-1');
  });

  it('never puts the system prompt on the wire', async () => {
    // The narrowing is the point: a header needs a name and a colour, and a
    // draft's instructions are not a header's business even for its owner.
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };

    const res = await thread();

    expect(JSON.stringify(res.body)).not.toContain('a prompt nobody else may read');
  });
});

describe('an agent nobody has told you about does not exist', () => {
  it('answers 404 — never 403 — to a stranger against an unpublished agent', async () => {
    const res = await thread();

    expect(res.status).toBe(404);
    // The BODY, exactly. A message that named the reason would confirm the
    // agent exists just as surely as a 403 would.
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(threads.findActiveThreadConversation).not.toHaveBeenCalled();
    // And Oxy really was asked, so this is a refusal rather than a short
    // circuit that would refuse an owner too.
    expect(state.accountLookups).toEqual(['acct-bot']);
  });

  it('answers the same body for a username Oxy has never heard of', async () => {
    state.profile = null;

    const res = await thread('nobody');

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
  });

  it('answers the same body when the handle is a person, not an agent', async () => {
    repository.findAgentByOxyAccountId.mockResolvedValue(null);

    const res = await thread();

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
  });

  it('answers the same body when Oxy cannot be reached', async () => {
    // The cost of collapsing every refusal, stated as a test rather than left
    // to be discovered: an owner whose Oxy is down is told their own agent does
    // not exist. Accepted, because the alternative distinguishes a draft that
    // exists from a handle that does not.
    state.unreachable = true;

    const res = await thread();

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
  });
});

describe('the three ways in', () => {
  it('lets the owner in', async () => {
    state.account = {
      kind: 'bot',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };

    expect((await thread()).status).toBe(200);
  });

  it('lets a member of the bot account in, who is not the author', async () => {
    // "Hiring" an agent is a membership on its Oxy account. The row's author is
    // `oxy-owner`; this caller is somebody else entirely.
    state.userId = 'oxy-colleague';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: ['account:act_as'] },
    };

    expect((await thread()).status).toBe(200);
  });

  it('lets anyone in when the agent is PUBLIC and active', async () => {
    repository.findAgentByOxyAccountId.mockResolvedValue({
      ...AGENT_ROW,
      isPublished: true,
      access: 'public',
      status: 'active',
    });

    const res = await thread();

    expect(res.status).toBe(200);
    // And it cost no Oxy round trip: a public agent needs no verdict at all,
    // which is why this is not one identity call per thread open.
    expect(state.accountLookups).toEqual([]);
  });

  it('keeps a stranger out of a PUBLISHED agent that is private', async () => {
    /**
     * The case the old rule could not express, and the one that proves the two
     * axes are separate: this agent is in the catalogue — findable, hireable in
     * appearance — and using it still takes its owner's say-so.
     *
     * `is_published && status === 'active'` returned true here until now, so
     * putting that line back turns this red and nothing else.
     */
    repository.findAgentByOxyAccountId.mockResolvedValue({
      ...AGENT_ROW,
      isPublished: true,
      access: 'private',
      status: 'active',
    });

    const res = await thread();

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    // Refused after ASKING, which is what tells this apart from a short circuit
    // that would refuse the owner too.
    expect(state.accountLookups).toEqual(['acct-bot']);
  });

  it('lets a plain member use a private agent, with no act-as of their own', async () => {
    /**
     * Sharing an agent IS adding somebody to its bot account, and the role that
     * gets is not necessarily one that can BECOME the account. Reading act-as
     * as "was shared with me" would make sharing work only for the roles that
     * can also edit — and editing is where the prompt is.
     */
    state.userId = 'oxy-colleague';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [], status: 'active' },
    };
    repository.findAgentByOxyAccountId.mockResolvedValue({
      ...AGENT_ROW,
      isPublished: true,
      access: 'private',
      status: 'active',
    });

    expect((await thread()).status).toBe(200);
  });

  it('keeps out somebody whose membership is not active yet', async () => {
    // An INVITED member has a row and has not accepted. The row is not the
    // grant; its status is.
    state.userId = 'oxy-invited';
    state.account = {
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [], status: 'invited' },
    };
    repository.findAgentByOxyAccountId.mockResolvedValue({
      ...AGENT_ROW,
      isPublished: true,
      access: 'private',
      status: 'active',
    });

    expect((await thread()).status).toBe(404);
  });

  it('refuses a public agent that is not active', async () => {
    // `access` alone is not the rule either. A suspended agent is not a thing a
    // stranger may open a thread with, and only `status` says so.
    repository.findAgentByOxyAccountId.mockResolvedValue({
      ...AGENT_ROW,
      isPublished: true,
      access: 'public',
      status: 'suspended',
    });

    const res = await thread();

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
  });
});
