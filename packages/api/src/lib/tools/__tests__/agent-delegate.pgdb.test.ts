/**
 * WHICH agent a delegation may run, against real rows.
 *
 * `delegateToAgent` took an id from the model and ran it: `findAgentById`, no
 * `access`, no `status`, no owner. Running an agent is reading it — the answer
 * IS that agent's `systemPrompt` applied to a task the caller chose — so an id
 * was enough to characterise a stranger's private draft, on a route where
 * `GET /agents/:id` had already been closed for exactly that reason.
 *
 * ## The standing case is what makes this more than a `public && active` pair
 *
 * Three of the cases below would also pass against a hand-written
 * `access === 'public' && status === 'active'` check. The fourth would not: an
 * agent that is PRIVATE and somebody else's, which this caller was added to,
 * must run — because sharing an agent is being added to its bot account, and
 * `canReachAgent` is the product's one answer to that question. Without it,
 * this file would be a test of a re-implementation.
 *
 * ## What is stubbed
 *
 * Oxy, at the seam `verifyAgentAccount` reaches it through — `getAccount` on
 * `@oxyhq/core`, answering an account node this file controls. The refusal
 * cache in front of it is real and cleared between cases. `generateText` and
 * the model resolution are stubbed for the same reason as everywhere else:
 * there is no model to call. The database, the credit arithmetic and
 * `canReachAgent` itself are real.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentDelegationResult } from '../agent-delegate.js';

/** The account node Oxy answers with, or `null` for a 404. */
const oxyAccount = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@oxyhq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core')>();
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {
        /* the stub authenticates nothing */
      }
      /**
       * `middleware/auth.ts` builds BOTH of its middlewares from this at MODULE
       * LOAD, and `agent-identity.ts` imports that module — so the stub has to
       * answer here or the import graph throws before a single case runs. No test
       * reaches either middleware.
       */
      auth(): () => Promise<null> {
        return async () => null;
      }
      serviceAuth(): () => Promise<null> {
        return async () => null;
      }
      async getAccount(): Promise<Record<string, unknown>> {
        if (oxyAccount.current === null) {
          throw Object.assign(new Error('no such account'), { status: 404 });
        }
        return oxyAccount.current;
      }
    },
  };
});

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      credits: child, agents: child, general: child, chat: child,
      v1: child, providers: child, tools: child, codea: child,
    },
  };
});

vi.mock('../../oxy-user-hydration.js', () => ({ hydrateOxyUsers: vi.fn(async () => new Map()) }));

vi.mock('../../chat-core.js', () => ({
  resolveModel: vi.fn(async (id: string) => ({
    id,
    oxyInferenceTarget: {
      kind: 'routing_profile_id',
      routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
    },
  })),
  getAIModel: vi.fn(() => ({ modelId: 'test-model' })),
}));

vi.mock('../../agent/soul.js', () => ({ evolveAgentSoul: vi.fn(async () => undefined) }));

const generateText = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText,
}));

const { closePostgres, connectPostgres } = await import('../../../db/index.js');
const { agents } = await import('../../../db/schema/agents.js');
const { userCredits } = await import('../../../db/schema/billing.js');
const { getOrCreateUserCredits } = await import('../../../db/billing/userCreditsRepository.js');
const { clearAgentAccountVerdicts } = await import('../../agent-account.js');
const { createDelegateToAgentTool } = await import('../agent-delegate.js');

let db: NonNullable<Awaited<ReturnType<typeof connectPostgres>>>;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  generateText.mockReset();
  oxyAccount.current = null;
  // The verdict cache lives for five minutes and is keyed by (caller, account).
  // Cleared here rather than relying on unique ids, so a case cannot be
  // answered by the case before it.
  clearAgentAccountVerdicts();
});

const SUITE = `delegate-${process.pid}`;
let seq = 0;
const uniqueId = (label: string): string => `${SUITE}-${label}-${seq++}`;

async function seedAgent(input: {
  author: string;
  access?: 'public' | 'private';
  status?: 'active' | 'idle' | 'offline';
}): Promise<{ id: string; oxyAccountId: string }> {
  const id = uniqueId('agent');
  const oxyAccountId = uniqueId('bot');
  await db.insert(agents).values({
    id,
    oxyAccountId,
    tagline: 'a seeded agent',
    description: 'seeded for the delegation suite',
    authorOxyUserId: input.author,
    category: 'research',
    access: input.access ?? 'private',
    status: input.status ?? 'active',
    systemPrompt: 'You are the seeded agent.',
    allowedModels: ['kaana-lite'],
  });
  return { id, oxyAccountId };
}

async function account(free: number): Promise<string> {
  const id = uniqueId('caller');
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: 0 }).where(eq(userCredits.id, id));
  return id;
}

async function balanceOf(id: string): Promise<number> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return row.creditsFree + row.creditsPaid;
}

/** Delegate to `agentId` as `caller`, through the real tool. */
async function delegate(
  caller: string,
  agentId: string,
  accessToken: string | undefined = 'bearer-1',
): Promise<AgentDelegationResult> {
  const tool = createDelegateToAgentTool(caller, accessToken);
  const execute = tool.execute;
  if (execute === undefined) throw new Error('delegateToAgent has no execute');
  const outcome = await execute({ agentId, task: 'summarise this' }, { toolCallId: 'c1', messages: [] });
  return outcome as AgentDelegationResult;
}

function answers(text: string): void {
  generateText.mockResolvedValue({
    text,
    usage: { inputTokens: 500, outputTokens: 500, totalTokens: 1_000 },
  });
}

describe('a delegation runs only an agent the caller may reach', () => {
  it('runs a PUBLIC, active agent belonging to somebody else', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'public' });
    answers('here you go');

    const outcome = await delegate(caller, target.id);

    // The control for every refusal below: delegation still works, and it does
    // not need the caller to own anything.
    expect(outcome.error).toBeUndefined();
    expect(outcome.response).toBe('here you go');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('refuses a PRIVATE agent belonging to somebody else, and says nothing else', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'private' });
    // Oxy: an account this caller cannot see, which is a 404 there.
    oxyAccount.current = null;
    answers('should never be produced');

    const outcome = await delegate(caller, target.id);

    /**
     * The bug this file exists for. The refusal is the SAME as a missing row —
     * a distinct message would confirm the id exists, which is what a private
     * draft must not tell a stranger who guessed one.
     */
    expect(outcome.error).toBe('Agent not found');
    expect(outcome.response).toBe('');
    expect(generateText).not.toHaveBeenCalled();
    // And it cost nothing: the refusal is before the reservation.
    expect(await balanceOf(caller)).toBe(100);
  });

  it('runs a PRIVATE agent the caller was added to, which a public-only check would refuse', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'private' });
    /**
     * Standing WITHOUT act-as: a membership on the bot account, which is what
     * sharing an agent is. The shared delegation resolver runs for real, so
     * this cannot pass through a test-local interpretation of Oxy's graph.
     */
    oxyAccount.current = {
      relationship: 'member',
      account: { kind: 'bot' },
      callerMembership: { status: 'active' },
    };
    answers('shared and running');

    const outcome = await delegate(caller, target.id);

    expect(outcome.error).toBeUndefined();
    expect(outcome.response).toBe('shared and running');
  });

  it('refuses a public agent its owner has switched OFF', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'public', status: 'idle' });
    oxyAccount.current = null;
    answers('should never be produced');

    const outcome = await delegate(caller, target.id);

    // `public` is who may use it; `status` is whether it is available at all.
    // Both halves of `canReachAgent`'s first branch, and this is the second.
    expect(outcome.error).toBe('Agent not found');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('refuses a private agent when the caller holds no bearer to be asked about', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'private' });
    answers('should never be produced');

    const outcome = await delegate(caller, target.id, undefined);

    // Fails CLOSED. A caller Oxy cannot be asked about reaches public agents
    // and nothing else, rather than everything.
    expect(outcome.error).toBe('Agent not found');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('still refuses an id that matches no agent at all', async () => {
    const caller = await account(100);

    const outcome = await delegate(caller, uniqueId('missing'));

    expect(outcome.error).toBe('Agent not found');
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('a delegation that runs is paid for by the delegating account', () => {
  it('settles the nested turn against the caller', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'public' });
    // 1000 tokens, `TOKENS_PER_CREDIT` 1000, `kaana-lite`'s multiplier 0.5 —
    // one credit, which is also the floor, so the assertion is the balance.
    answers('billed');

    await delegate(caller, target.id);

    expect(await balanceOf(caller)).toBe(99);
  });

  it('leaves the balance as it found it when the delegate fails', async () => {
    const caller = await account(100);
    const target = await seedAgent({ author: uniqueId('other'), access: 'public' });
    generateText.mockRejectedValue(new Error('the provider fell over'));

    const outcome = await delegate(caller, target.id);

    // The reservation is a debit. Delegation reserved nothing at all before, so
    // this is the first run of this path in either direction.
    expect(outcome.error).toBe('the provider fell over');
    expect(await balanceOf(caller)).toBe(100);
  });
});
