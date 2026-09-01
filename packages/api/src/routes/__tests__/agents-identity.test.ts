/**
 * `POST /agents` and `PATCH /agents/:id` — who an agent IS, and who may act as it.
 *
 * A REAL express server, because three of the properties under test belong to
 * express and not to the handler: that a 400 body never reaches the repository,
 * that the status codes are what a client branches on, and that the router is
 * reachable at all.
 *
 * Only OXY is replaced. `lib/agent-account.ts` runs for real — including
 * `canSwitchIntoAccount` from `@oxyhq/core`, which is imported for real through
 * `importActual`, so what these assert is the SHIPPED act-as rule rather than a
 * fixture's opinion of it. The repository is a spy because what matters here is
 * whether it was reached, and with what.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';

/** An `AccountNode` as `GET /accounts/:id` answers it, or a refusal. */
const state = vi.hoisted(() => ({
  /** `null` makes `getAccount` reject with a 404, as Oxy does for an unseen account. */
  account: null as null | {
    accountId: string;
    kind: string;
    relationship: string;
    callerMembership: null | { permissions: string[] };
  },
  /** `true` makes `getAccount` reject with a transport failure, not a 404. */
  unreachable: false,
  /** Every `getAccount` call, so "asked Oxy at all" is assertable. */
  accountLookups: [] as string[],
  /** What `POST /users/by-ids` resolves. Empty means Oxy resolved nothing. */
  users: [] as {
    id: string;
    username: string;
    name: { displayName?: string };
    avatar?: string;
    color?: string;
  }[],
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
  // The act-as rule itself is the real one. Only the transport is a fixture.
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

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    const typed = req as Request & { user?: { id: string }; accessToken?: string };
    typed.user = { id: state.userId };
    typed.accessToken = state.accessToken;
    next();
  },
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
    const typed = req as Request & { user?: { id: string } };
    typed.user = { id: state.userId };
    next();
  },
  oxyClient: {
    getUsersByIds: async () => state.users,
    getFileDownloadUrl: (id: string, variant?: string) =>
      `https://cloud.oxy.so/${id}?variant=${variant ?? ''}`,
  },
}));

const repository = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  findAgentById: vi.fn(),
  findAgentSkills: vi.fn(async () => []),
  findAgentKnowledge: vi.fn(async () => []),
  listAgentCatalogue: vi.fn(async () => ({ agents: [], total: 0 })),
  listAgentsByAuthor: vi.fn(async () => []),
}));

vi.mock('../../db/agents/agentRepository.js', () => repository);
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../lib/agent/health.js', () => ({ getAgentCapabilities: async () => ({}) }));
vi.mock('../../lib/logger.js', () => ({
  log: { agents: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../lib/trigger-engine.js', () => ({
  reloadTrigger: vi.fn(),
  generateWebhookToken: () => 'tok',
}));
vi.mock('../../db/automation/triggerRepository.js', () => ({
  createTrigger: vi.fn(),
  findAgentTriggerByType: vi.fn(async () => null),
  updateTrigger: vi.fn(),
}));

const { default: crudRouter } = await import('../agents/crud.js');
const { clearAgentAccountVerdicts, verifyAgentAccount } = await import(
  '../../lib/agent-account.js',
);

const AGENT_ROW = {
  _id: 'agent-1',
  id: 'agent-1',
  oxyAccountId: 'acct-bot',
  tagline: 'finds things out',
  description: 'a description',
  author: 'oxy-caller',
  category: 'research',
  tags: [],
  rating: 0,
  reviewCount: 0,
  usageCount: 0,
  hireCount: 0,
  price: null,
  capabilities: [],
  isFeatured: false,
  isTrending: false,
  isPublished: true,
  status: 'active',
  allowHiring: false,
  handlesAutonomousEvents: false,
  systemPrompt: null,
  preferredImage: null,
  allowedModels: ['kaana-v1'],
  scheduleInterval: null,
  archetype: 'general',
  archetypeConfig: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

let app: Express;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use('/agents', crudRouter);
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
  state.users = [];
  // The default: a bot account this caller owns outright.
  state.account = {
    accountId: 'acct-bot',
    kind: 'bot',
    relationship: 'owner',
    callerMembership: { permissions: ['account:act_as'] },
  };
  repository.createAgent.mockResolvedValue(AGENT_ROW);
  repository.updateAgent.mockResolvedValue(AGENT_ROW);
  repository.findAgentById.mockResolvedValue(AGENT_ROW);
  repository.deleteAgent.mockResolvedValue(1);
});

const VALID_BODY = {
  oxyAccountId: 'acct-bot',
  tagline: 'finds things out',
  description: 'a description',
  category: 'research',
};

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function patch(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/agents/agent-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('an agent cannot be created without a bot account', () => {
  it('refuses a body with no oxyAccountId, and never reaches the repository', async () => {
    const { oxyAccountId: _omitted, ...withoutAccount } = VALID_BODY;
    const res = await post(withoutAccount);

    expect(res.status).toBe(400);
    expect(repository.createAgent).not.toHaveBeenCalled();
    // And it never asked Oxy either: there was nothing to ask about.
    expect(state.accountLookups).toEqual([]);
  });

  /**
   * The fields Oxy owns are REFUSED rather than dropped.
   *
   * A client still sending `name` believes it is naming the agent. Ignoring it
   * silently leaves the agent called whatever the bot account is called, with
   * nothing anywhere to say why — which is the failure `.strict()` exists to
   * turn into a 400 that names the field.
   */
  it.each(['name', 'handle', 'color', 'authorName', 'creditBalance'])(
    'refuses a body still carrying %s',
    async (field) => {
      const res = await post({ ...VALID_BODY, [field]: 'anything' });

      expect(res.status).toBe(400);
      expect(repository.createAgent).not.toHaveBeenCalled();
    },
  );
});

describe('the account has to be a bot account this caller may act as', () => {
  it('refuses an account that is not kind:bot', async () => {
    state.account = {
      accountId: 'acct-bot',
      kind: 'organization',
      relationship: 'owner',
      callerMembership: { permissions: ['account:act_as'] },
    };

    const res = await post(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The account is not a bot account');
    expect(repository.createAgent).not.toHaveBeenCalled();
  });

  /**
   * `personal` is the case that matters most, and it is why `kind === 'bot'` is
   * checked SEPARATELY from the act-as verdict: `canSwitchIntoAccount` passes
   * any account whose relationship is `self`, whatever its kind, so a caller
   * naming their OWN account would otherwise turn themselves into an agent.
   */
  it('refuses the caller’s own personal account', async () => {
    state.account = {
      accountId: 'acct-bot',
      kind: 'personal',
      relationship: 'self',
      callerMembership: null,
    };

    const res = await post(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The account is not a bot account');
    expect(repository.createAgent).not.toHaveBeenCalled();
  });

  it('answers 403 when the caller holds no account:act_as', async () => {
    state.account = {
      accountId: 'acct-bot',
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: ['account:read'] },
    };

    const res = await post(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You do not have permission to act as this account');
    expect(repository.createAgent).not.toHaveBeenCalled();
  });

  it('answers 404 for an account Oxy will not show this caller', async () => {
    state.account = null;

    const res = await post(VALID_BODY);

    expect(res.status).toBe(404);
    expect(repository.createAgent).not.toHaveBeenCalled();
  });

  /**
   * An Oxy OUTAGE is not a denial, and is a different status on purpose.
   *
   * Telling an owner their own agent is not theirs is a worse lie than telling
   * them the identity service is down — and a 403 is what a client renders as
   * "you have lost access", which would be false.
   */
  it('answers 502, not 403, when Oxy cannot be asked', async () => {
    state.unreachable = true;

    const res = await post(VALID_BODY);

    expect(res.status).toBe(502);
    expect(repository.createAgent).not.toHaveBeenCalled();
  });

  it('accepts a bot account granted through an INHERITED membership', async () => {
    // A membership on an ancestor cascades, and the server resolves it into
    // `callerMembership`. A verdict that only accepted `relationship: 'owner'`
    // would refuse every delegate an owner deliberately added.
    state.account = {
      accountId: 'acct-bot',
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: ['account:act_as'] },
    };

    const res = await post(VALID_BODY);

    expect(res.status).toBe(201);
    expect(repository.createAgent).toHaveBeenCalledTimes(1);
  });
});

describe('a created agent', () => {
  it('stores the bot account and the caller as author, and nothing about identity', async () => {
    const res = await post(VALID_BODY);

    expect(res.status).toBe(201);
    const input = repository.createAgent.mock.calls[0][1] as Record<string, unknown>;
    expect(input.oxyAccountId).toBe('acct-bot');
    expect(input.authorOxyUserId).toBe('oxy-caller');
    expect(Object.keys(input)).not.toContain('name');
    expect(Object.keys(input)).not.toContain('handle');
    expect(Object.keys(input)).not.toContain('color');
  });

  it('answers with the identity read from Oxy, not from the row', async () => {
    state.users = [
      {
        id: 'acct-bot',
        username: 'researcher',
        name: { displayName: 'The Researcher' },
        // Still SET on the account, and deliberately so: this asserts Alia
        // stops reading it rather than that Oxy stops storing one. An account
        // that carries a picture from somewhere else must not resurface it as
        // an agent's face.
        avatar: 'asset-7',
        color: 'lagoon',
      },
    ];

    const res = await post(VALID_BODY);
    const agent = res.body.agent as Record<string, unknown>;

    expect(agent.name).toBe('The Researcher');
    expect(agent.handle).toBe('researcher');
    expect(agent.color).toBe('lagoon');
    expect(agent).not.toHaveProperty('avatar');
  });

  /**
   * The colour is null far more often than the name is, and this is the case
   * that says so: Oxy RESOLVED the account, it simply has no colour. A client
   * draws its own fallback, which is why nothing here validates the value.
   */
  it('answers a null colour for an account that resolved without one', async () => {
    state.users = [
      { id: 'acct-bot', username: 'researcher', name: { displayName: 'The Researcher' } },
    ];

    const res = await post(VALID_BODY);
    const agent = res.body.agent as Record<string, unknown>;

    expect(agent.name).toBe('The Researcher');
    expect(agent.color).toBeNull();
  });

  /**
   * Identity hydration FAILS OPEN. An account Oxy cannot resolve leaves the
   * three fields null and the listing still renders — the tagline, the rating
   * and the price are stored right here, and an identity lookup does not get to
   * decide whether they can be shown.
   */
  it('answers nulls rather than failing when Oxy resolves nothing', async () => {
    state.users = [];

    const res = await post(VALID_BODY);
    const agent = res.body.agent as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(agent.name).toBeNull();
    expect(agent.handle).toBeNull();
    expect(agent.color).toBeNull();
    expect(agent.tagline).toBe('finds things out');
  });
});

describe('a patch is gated by act_as, not by the author column', () => {
  it('lets a delegate who is NOT the author write', async () => {
    // The row's author is `oxy-caller`; this request is somebody else entirely,
    // holding `account:act_as` on the bot. Under the old `{_id, author}`
    // predicate this was a 404.
    state.userId = 'oxy-delegate';
    state.account = {
      accountId: 'acct-bot',
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: ['account:act_as'] },
    };

    const res = await patch({ tagline: 'a new tagline' });

    expect(res.status).toBe(200);
    expect(repository.updateAgent).toHaveBeenCalledTimes(1);
    // The owner predicate is gone from the repository call itself.
    expect(repository.updateAgent.mock.calls[0]).toHaveLength(3);
  });

  it('answers 404 — not 403 — to a caller with no act_as', async () => {
    state.account = {
      accountId: 'acct-bot',
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [] },
    };

    const res = await patch({ tagline: 'a new tagline' });

    expect(res.status).toBe(404);
    expect(repository.updateAgent).not.toHaveBeenCalled();
  });

  it.each(['name', 'color', 'oxyAccountId', 'creditBalance'])(
    'refuses a patch of %s, which is not Alia’s to write',
    async (field) => {
      const res = await patch({ [field]: 'anything' });

      expect(res.status).toBe(400);
      expect(repository.updateAgent).not.toHaveBeenCalled();
    },
  );
});

/**
 * The READ half of the cache split, exercised on the function rather than
 * through a route.
 *
 * No product route caches today — every one that authorises is a write — so
 * routing these through `POST` would assert the opposite of what they are
 * about. The socket's `subscribe-agent` is the live `cache: true` caller and it
 * has no HTTP surface to drive from here.
 */
describe('a cached verdict is reusable, and the cache is keyed by CALLER', () => {
  const read = (oxyUserId: string) =>
    verifyAgentAccount({ oxyUserId, accessToken: 'token-abc', oxyAccountId: 'acct-bot', cache: true });

  it('asks Oxy once for repeated reads by the same caller', async () => {
    await read('oxy-caller');
    await read('oxy-caller');

    expect(state.accountLookups).toEqual(['acct-bot']);
  });

  /**
   * A cache keyed on the account alone would hand one caller's grant to
   * another. This is the assertion that says it is not.
   */
  it('asks again for a DIFFERENT caller on the same account', async () => {
    await read('oxy-caller');
    await read('oxy-somebody-else');

    expect(state.accountLookups).toEqual(['acct-bot', 'acct-bot']);
  });

  /** An outage must never become a cached grant, nor a cached refusal. */
  it('does not cache an unreachable-Oxy refusal', async () => {
    state.unreachable = true;
    await read('oxy-caller');
    await read('oxy-caller');

    expect(state.accountLookups).toEqual(['acct-bot', 'acct-bot']);
  });
});

/**
 * A write must never be answered from the verdict cache.
 *
 * Five minutes of a revoked membership still being effective is a real window
 * in which somebody writes to an account that is no longer theirs. The reads
 * keep the cache — they arrive in pages — and the writes pay a round trip each,
 * which is affordable because there are few of them and none in a loop.
 */
describe('a mutation never trusts a cached verdict', () => {
  it.each([
    ['POST', async () => post(VALID_BODY)],
    ['PATCH', async () => patch({ tagline: 'a new tagline' })],
    [
      'DELETE',
      async () => {
        const res = await fetch(`${baseUrl}/agents/agent-1`, { method: 'DELETE' });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
    ],
  ])('asks Oxy again on every %s', async (_method, call) => {
    await call();
    await call();

    expect(state.accountLookups).toEqual(['acct-bot', 'acct-bot']);
  });

  /**
   * The property the split exists for, stated directly: a grant that goes away
   * stops working on the NEXT write, not five minutes later.
   *
   * The first call warms the cache with a permitted verdict, which is what
   * makes this test able to fail — against a cached write path the second call
   * succeeds.
   */
  it('refuses the write immediately after the membership is revoked', async () => {
    expect((await patch({ tagline: 'while permitted' })).status).toBe(200);

    state.account = {
      accountId: 'acct-bot',
      kind: 'bot',
      relationship: 'member',
      callerMembership: { permissions: [] },
    };

    expect((await patch({ tagline: 'after revocation' })).status).toBe(404);
  });
});

/**
 * A unique violation shaped like the one postgres.js actually throws.
 *
 * MEASURED, not guessed: `name`, `code` and `constraint_name` sit on the error
 * ITSELF, and `@oxyhq/db`'s reader walks the `cause` chain only while each link
 * `instanceof Error`. An earlier version of this fixture hung the fields on a
 * plain-object `cause`, which the walk cannot enter — so it was not a unique
 * violation at all and the case it was written for passed for the wrong reason.
 *
 * `assertFaithful` below is the positive control that keeps it honest: if the
 * shape ever stops satisfying the SHIPPED predicate, this fails here rather
 * than quietly making every case in this block vacuous.
 */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    name: 'PostgresError',
    code: '23505',
    constraint_name: constraint,
  });
}

describe('the autonomy designation is declared, and bounded to one per owner', () => {
  it('uses a violation fixture the SHIPPED predicate recognises', () => {
    const violation = uniqueViolation('agents_one_autonomy_per_owner');
    expect(isUniqueViolation(violation)).toBe(true);
    expect(constraintNameOf(violation)).toBe('agents_one_autonomy_per_owner');
  });

  it('accepts it on create and passes it to the repository', async () => {
    const res = await post({ ...VALID_BODY, handlesAutonomousEvents: true });

    expect(res.status).toBe(201);
    const input = repository.createAgent.mock.calls[0][1] as Record<string, unknown>;
    expect(input.handlesAutonomousEvents).toBe(true);
  });

  it('defaults to false rather than to whatever the column says', async () => {
    await post(VALID_BODY);

    const input = repository.createAgent.mock.calls[0][1] as Record<string, unknown>;
    expect(input.handlesAutonomousEvents).toBe(false);
  });

  /**
   * The partial unique index is the authority, so a second designation arrives
   * as a constraint violation. A 500 would tell the owner their edit broke
   * Alia; a 409 tells them they already have one.
   */
  it('answers 409, not 500, when the owner already has a designated agent', async () => {
    const violation = uniqueViolation('agents_one_autonomy_per_owner');
    repository.updateAgent.mockRejectedValueOnce(violation);

    const res = await patch({ handlesAutonomousEvents: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Another of your agents already handles autonomous events');
  });

  /** A DIFFERENT unique violation is not this one, and must not read as a 409. */
  it('does not turn an unrelated unique violation into that 409', async () => {
    const violation = uniqueViolation('agents_oxy_account_id_key');
    repository.updateAgent.mockRejectedValueOnce(violation);

    const res = await patch({ handlesAutonomousEvents: true });

    expect(res.status).toBe(500);
  });
});
