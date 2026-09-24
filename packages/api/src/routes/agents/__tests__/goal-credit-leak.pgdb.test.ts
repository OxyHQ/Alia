import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';

/**
 * `POST /agents/threads/:threadId/goals`, driven through the REAL router against
 * a REAL Postgres server, for one property: **the caller's balance comes back
 * when the hire does not happen** — and, when it does, the goal records the
 * price that was actually taken.
 *
 * A goal is the paid hire. This file was written against `POST /agents/:id/hire`
 * and moved here when that route was retired: the protection it measures lives
 * in `startAgentSession`, and the only route that reaches it now is this one.
 *
 * The hire used to reserve the agent's price, write a session, increment
 * counters and enqueue a job inside one `try`, and answered any failure with
 * `log.error` plus a 500. `reserveCredits` DEBITS, so each of those 500s cost
 * the caller fifteen credits for an agent that never ran — invisibly, because
 * the 500 is the only thing anybody sees and nothing connects it to a balance.
 *
 * The assertions are therefore about the BALANCE, never about the status code.
 * A test that checked the 500 passes against the code that leaks.
 */

vi.mock('../../../middleware/auth.js', () => {
  /** The caller is whoever the request names — the route's own rules decide the rest. */
  const signIn = (req: Request, _res: Response, next: NextFunction): void => {
    const typed = req as Request & { user?: { id: string }; accessToken?: string };
    typed.user = { id: String(req.header('x-test-user')) };
    typed.accessToken = 'token';
    next();
  };
  return { authenticateToken: signIn, optionalAuth: signIn, authenticateTokenOrApiKey: signIn };
});
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, credits: child, providers: child } };
});
vi.mock('../../../lib/chat-core.js', () => ({
  getRoutingProfile: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));
vi.mock('../../../lib/task-queue.js', () => ({
  enqueueAgentSession: vi.fn(async () => ({ queued: true, jobId: 'job-1' })),
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { userCredits } from '../../../db/schema/billing.js';
import { agentSessions } from '../../../db/schema/agent-sessions.js';
import { agentGoals } from '../../../db/schema/agent-runtime.js';
import { agents } from '../../../db/schema/agents.js';
import { createAgent } from '../../../db/agents/agentRepository.js';
import { createAgentThread } from '../../../db/agents/agentRuntimeRepository.js';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository.js';
import { enqueueAgentSession } from '../../../lib/task-queue.js';
import threadsRouter from '../threads.js';


let db: ApiDatabase;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;

  const app = express();
  app.use(express.json());
  app.use('/agents', threadsRouter);
  // The router hands a thrown handler to `next`; say so as a 500 rather than
  // an HTML page the assertions would have to parse.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: String(err) });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `goal-${process.pid}`;
let seq = 0;

async function account(free: number, paid: number): Promise<string> {
  const id = `${SUITE}-${seq++}`;
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: paid }).where(eq(userCredits.id, id));
  return id;
}

async function balanceOf(id: string): Promise<{ free: number; paid: number }> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

/**
 * A PUBLIC agent, which is what lets a stranger hire it at all. Who may hire a
 * PRIVATE one is a question about the rule rather than about credits, and it is
 * measured in `goal-access.test.ts`.
 */
async function seedAgent(price: number | null = 15): Promise<string> {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-goal-${SUITE}-${seq++}`,
    ownerOxyAccountId: SUITE,
    tagline: 'runs things',
    description: 'd',
    authorOxyUserId: SUITE,
    category: 'research',
    price,
    isPublished: true,
    access: 'public',
  });
  return agent._id;
}

/** The caller's own open thread with the agent, which is what a goal starts on. */
async function threadFor(userId: string, agentId: string): Promise<string> {
  const thread = await createAgentThread(db, {
    oxyUserId: userId,
    agentId,
    title: 'work',
  });
  return thread.id;
}

async function hire(
  userId: string,
  threadId: string,
  objective: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/agents/threads/${threadId}/goals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${SUITE}-key-${seq++}`,
      'x-test-user': userId,
    },
    body: JSON.stringify({ objective }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function goalPrice(body: Record<string, unknown>): Promise<number | undefined> {
  const goalId = (body.goal as { id?: string } | undefined)?.id;
  if (goalId === undefined) return undefined;
  const [row] = await db.select().from(agentGoals).where(eq(agentGoals.id, goalId));
  return row?.priceCredits;
}

describe('POST /agents/threads/:threadId/goals — the reservation', () => {
  it('stays spent when the hire succeeds, because the worker settles it', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();

    const res = await hire(userId, await threadFor(userId, agentId), 'do the thing');

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ sessionId: expect.any(String) });
    // The positive control for every case below: a route that refunded
    // unconditionally would satisfy all of them and fail this one.
    expect(await balanceOf(userId)).toEqual({ free: 85, paid: 0 });
  });

  it('comes back when the ENQUEUE fails', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    const res = await hire(userId, await threadFor(userId, agentId), 'never queued');

    expect(res.status).toBe(500);
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  /**
   * A hire whose handoff failed must not be reachable by the reclaim sweep
   * afterwards, or the account is paid twice for one reservation.
   */
  it('leaves no queued row behind, and cancels the goal, when the enqueue fails', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    const res = await hire(userId, await threadFor(userId, agentId), 'never queued');

    const rows = await db.select().from(agentSessions).where(eq(agentSessions.agentId, agentId));
    expect(rows.map((row) => row.status)).toEqual(['cancelled']);
    const goals = await db.select().from(agentGoals).where(eq(agentGoals.agentId, agentId));
    expect(goals.map((goal) => goal.status)).toEqual(['cancelled']);
    expect(res.status).toBe(500);
  });

  it('comes back to the PAID balance for an account whose allowance is spent', async () => {
    const userId = await account(0, 100);
    const agentId = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await hire(userId, await threadFor(userId, agentId), 'never queued');

    // Not `{free: 15, paid: 85}`: `refreshFreeCreditsIfDue` overwrites
    // `credits_free` daily, so a refund into it destroys purchased credit.
    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });

  /**
   * A first-time owner is PROVISIONED, not refused.
   *
   * `reserveCredits` does not create a balance row — `spendCreditsFreeFirst` is
   * an UPDATE, so an account with no row matches nothing and reads as "cannot
   * pay". The symptom was a 402 telling somebody to buy credits while they were
   * entitled to three hundred free ones they had simply never collected.
   *
   * `res.body` is asserted BEFORE the balance deliberately: `balanceOf` throws
   * when the row is absent, which is precisely the pre-fix state, so reading it
   * first would report this as a helper exception instead of as the 402 it is.
   */
  it('provisions a first-time owner rather than telling them to buy credits', async () => {
    // No `account()` — this id has no `user_credits` row at all.
    const userId = `${SUITE}-fresh-${seq++}`;
    const agentId = await seedAgent();

    const res = await hire(userId, await threadFor(userId, agentId), 'first action on this account');

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    // The default allowance minus the agent's price: the credits they already
    // had by right, which the refusal was denying them.
    expect(await balanceOf(userId)).toEqual({ free: 285, paid: 0 });
  });

  it('debits nothing when the balance will not cover the price', async () => {
    const userId = await account(3, 0);
    const agentId = await seedAgent();

    const res = await hire(userId, await threadFor(userId, agentId), 'too expensive');

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ creditsNeeded: 15 });
    expect(await balanceOf(userId)).toEqual({ free: 3, paid: 0 });
  });

  it('counts the hire exactly once on the agent it hired', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();

    await hire(userId, await threadFor(userId, agentId), 'do the thing');

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect({ hireCount: row?.hireCount, usageCount: row?.usageCount }).toEqual({
      hireCount: 1,
      usageCount: 1,
    });
  });
});

/**
 * The goal RECORDS a price and the handoff RESERVES one. They were two
 * expressions — `agent.price ?? 0` and `agent.price || 15` — so an agent with no
 * price produced a goal that said 0 while the balance lost 15. Measured as the
 * balance difference, so the recorded number is compared with what was taken,
 * not with a second copy of the rule.
 */
describe('the price a goal records is the price it reserved', () => {
  it.each([
    ['a priced agent', 12],
    ['an agent with no price', null],
    ['an agent priced at zero', 0],
  ])('for %s', async (_label, price) => {
    const userId = await account(100, 0);
    const agentId = await seedAgent(price);

    const res = await hire(userId, await threadFor(userId, agentId), 'priced work');

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const after = await balanceOf(userId);
    const taken = 100 - after.free;
    // The floor: something was reserved, so an equality of two zeros cannot pass.
    expect(taken).toBeGreaterThan(0);
    expect(await goalPrice(res.body)).toBe(taken);
  });
});
