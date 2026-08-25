import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * `POST /agents/:id/hire`, driven through the REAL handler against a REAL
 * Postgres server, for one property: **the caller's balance comes back when the
 * hire does not happen.**
 *
 * The route reserved the agent's price, wrote a session, incremented counters
 * and enqueued a job inside one `try`, and answered any failure with
 * `log.error` plus a 500. `reserveCredits` DEBITS, so each of those 500s cost
 * the caller fifteen credits for an agent that never ran — invisibly, because
 * the 500 is the only thing anybody sees and nothing connects it to a balance.
 *
 * The assertions are therefore about the BALANCE, never about the status code.
 * A test that checked the 500 passes against the code that leaks.
 */

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateTokenOrApiKey: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, credits: child, providers: child } };
});
vi.mock('../../../lib/chat-core.js', () => ({
  getAliaModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));
vi.mock('../../../lib/agent/health.js', () => ({
  getAgentCapabilities: vi.fn(async () => ({ shell: true, browser: true })),
}));
vi.mock('../../../lib/task-queue.js', () => ({
  enqueueAgentSession: vi.fn(async () => ({ queued: true, jobId: 'job-1' })),
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { userCredits } from '../../../db/schema/billing.js';
import { agentSessions } from '../../../db/schema/agent-sessions.js';
import { agents } from '../../../db/schema/agents.js';
import { createAgent } from '../../../db/agents/agentRepository.js';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository.js';
import { enqueueAgentSession } from '../../../lib/task-queue.js';
import hireRouter from '../hire.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  Driving the real router                                                    */
/* -------------------------------------------------------------------------- */

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;

interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: Handler }> };
}

/** The LAST handler on a route layer is the route's own, after its middleware. */
function hireHandler(): Handler {
  const stack = (hireRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find(
    (entry) => entry.route?.path === '/:id/hire' && entry.route.methods?.post === true,
  );
  expect(layer?.route, 'POST /:id/hire is not mounted').toBeDefined();
  const handlers = layer?.route?.stack ?? [];
  expect(handlers.length, 'POST /:id/hire has no handler').toBeGreaterThan(0);
  return handlers[handlers.length - 1].handle;
}

async function hire(userId: string, agentId: string, task: string): Promise<{ status: number; body: unknown }> {
  const recorded = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) { recorded.status = code; return res; },
    json(payload: unknown) { recorded.body = payload; return res; },
    send(payload: unknown) { recorded.body = payload; return res; },
    setHeader() { /* unused */ },
  };
  await hireHandler()(
    { user: { id: userId }, params: { id: agentId }, query: {}, body: { task } },
    res,
  );
  return recorded;
}

/* -------------------------------------------------------------------------- */

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `hire-${process.pid}`;
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

async function seedAgent(): Promise<string> {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-hire-${SUITE}-${seq++}`,
    tagline: 'runs things',
    description: 'd',
    authorOxyUserId: SUITE,
    category: 'research',
    price: 15,
    isPublished: true,
  });
  return agent._id;
}

describe('POST /agents/:id/hire — the reservation', () => {
  it('stays spent when the hire succeeds, because the worker settles it', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();

    const res = await hire(userId, agentId, 'do the thing');

    expect(res.body).toMatchObject({ hired: true });
    // The positive control for every case below: a route that refunded
    // unconditionally would satisfy all of them and fail this one.
    expect(await balanceOf(userId)).toEqual({ free: 85, paid: 0 });
  });

  it('comes back when the ENQUEUE fails', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    const res = await hire(userId, agentId, 'never queued');

    expect(res.status).toBe(500);
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  /**
   * A hire whose handoff failed must not be reachable by the reclaim sweep
   * afterwards, or the account is paid twice for one reservation.
   */
  it('leaves no queued row behind when the enqueue fails', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await hire(userId, agentId, 'never queued');

    const rows = await db.select().from(agentSessions).where(eq(agentSessions.agentId, agentId));
    expect(rows.map((row) => row.status)).toEqual(['cancelled']);
  });

  it('comes back to the PAID balance for an account whose allowance is spent', async () => {
    const userId = await account(0, 100);
    const agentId = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await hire(userId, agentId, 'never queued');

    // Not `{free: 15, paid: 85}`: `refreshFreeCreditsIfDue` overwrites
    // `credits_free` daily, so a refund into it destroys purchased credit.
    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });

  /**
   * A first-time owner is PROVISIONED, not refused.
   *
   * `reserveCredits` does not create a balance row — `spendCreditsFreeFirst` is
   * an UPDATE, so an account with no row matches nothing and reads as "cannot
   * pay". Twelve of the fifteen reserve sites in this service call
   * `getOrCreateUserCredits` immediately before reserving; this route reached
   * `reserveCredits` through `startAgentSession`, which did not.
   *
   * The symptom was a 402 telling somebody to buy credits while they were
   * entitled to three hundred free ones they had simply never collected. It
   * needed no agent balance and no fallback to happen: it is reachable with one
   * payer, today, by anyone whose first authenticated action is hiring an agent
   * — a trigger firing for an owner who has never opened the app, or an API-key
   * consumer who never will.
   *
   * `res.body` is asserted BEFORE the balance deliberately: `balanceOf` throws
   * when the row is absent, which is precisely the pre-fix state, so reading it
   * first would report this as a helper exception instead of as the 402 it is.
   * A red for the wrong reason is not a red.
   */
  it('provisions a first-time owner rather than telling them to buy credits', async () => {
    // No `account()` — this id has no `user_credits` row at all.
    const userId = `${SUITE}-fresh-${seq++}`;
    const agentId = await seedAgent();

    const res = await hire(userId, agentId, 'first action on this account');

    expect(res.body).toMatchObject({ hired: true });
    // The default allowance minus the agent's price: the credits they already
    // had by right, which the refusal was denying them.
    expect(await balanceOf(userId)).toEqual({ free: 285, paid: 0 });
  });

  it('debits nothing when the balance will not cover the price', async () => {
    const userId = await account(3, 0);
    const agentId = await seedAgent();

    const res = await hire(userId, agentId, 'too expensive');

    expect(res.status).toBe(402);
    expect(await balanceOf(userId)).toEqual({ free: 3, paid: 0 });
  });

  it('counts the hire exactly once on the agent it hired', async () => {
    const userId = await account(100, 0);
    const agentId = await seedAgent();

    await hire(userId, agentId, 'do the thing');

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect({ hireCount: row?.hireCount, usageCount: row?.usageCount }).toEqual({
      hireCount: 1,
      usageCount: 1,
    });
  });
});
