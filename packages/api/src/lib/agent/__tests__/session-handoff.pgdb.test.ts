import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * The credit-safe handoff of an agent session to a worker, against a REAL
 * Postgres server.
 *
 * ## The bug this file exists for looks like nothing at all
 *
 * `reserveCredits` DEBITS. Three call sites — `routes/agents/hire.ts`,
 * `lib/agent/routing-handler.ts` and the agent-escalation branch of
 * `routes/v1/chat-completions.ts` — reserved an agent's price, created a
 * session, incremented counters and enqueued a job, and answered a failure of
 * any of those with a `log.error`. The request 500s, which somebody notices;
 * the fifteen credits are gone, which nobody does, because no line anywhere
 * says so and the balance is simply lower than it was.
 *
 * So every case here asserts the BALANCE, before and after. A test that only
 * checked the return value would pass against the code that leaks.
 *
 * ## Why the failures are injected into the repository, not simulated
 *
 * Each `vi.mocked(...).mockRejectedValueOnce` stands for a real event: a
 * connection lost between two statements, a task killed mid-request, Postgres
 * refusing a write. What matters is only WHERE the throw lands, because each
 * position leaves a different amount of state behind — and the balance has to
 * come back from all of them.
 *
 * The credits half is NOT mocked. `reserveCredits` and `safeRefund` run against
 * the real table, so "the balance came back" is a fact about rows rather than
 * about which spy was called.
 */

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, triggers: child, credits: child, providers: child } };
});
vi.mock('../../chat-core.js', () => ({
  getAliaModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));
vi.mock('../../task-queue.js', () => ({
  enqueueAgentSession: vi.fn(async () => ({ queued: true, jobId: 'job-1' })),
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePostgres, connectPostgres, getDb, type ApiDatabase } from '../../../db/index.js';
import { userCredits } from '../../../db/schema/billing.js';
import { agentSessions } from '../../../db/schema/agent-sessions.js';
import { agents } from '../../../db/schema/agents.js';
import { createAgent } from '../../../db/agents/agentRepository.js';
import {
  createAgentSession,
  findAgentSessionById,
} from '../../../db/agents/agentSessionRepository.js';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository.js';
import { enqueueAgentSession } from '../../task-queue.js';
import { reclaimOrphanedAgentSessions, startAgentSession } from '../session-handoff.js';

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

/**
 * Ids namespaced by pid: the pgdb suite shares ONE database across files that
 * run in parallel, so a fixed account id would collide with a sibling's.
 */
const SUITE = `handoff-${process.pid}`;
let seq = 0;
const nextId = () => `${SUITE}-${seq++}`;

/** An account with an exact opening balance. */
async function account(free: number, paid: number): Promise<string> {
  const id = nextId();
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
 * Age this file's own session rows past the sweep's cutoff.
 *
 * NOT a future `now` handed to the sweep. The pgdb suite shares ONE database and
 * its files run in parallel; `claimOrphanedQueuedAgentSessions` is global by
 * design, so a cutoff in the future would claim — and refund — the queued
 * sessions a sibling file created seconds ago. Moving only this file's rows
 * backwards leaves the sweep running against the real clock, where a sibling's
 * fresh row is nowhere near the cutoff.
 */
async function backdate(agentId: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    .where(eq(agentSessions.agentId, agentId));
}

async function seedAgent(price: number): Promise<{ _id: string; name: string; price: number }> {
  const agent = await createAgent(db, {
    name: 'Runner',
    handle: `handoff-${SUITE}-${seq++}`,
    tagline: 'runs things',
    description: 'd',
    authorOxyUserId: SUITE,
    authorName: 'Nate',
    category: 'research',
    price,
  });
  return { _id: agent._id, name: agent.name, price };
}

describe('startAgentSession', () => {
  it('hands off successfully and keeps the price reserved for the worker', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);

    const outcome = await startAgentSession({ agent, userId, task: 'do the thing', origin: 'hire' });

    expect(outcome.ok).toBe(true);
    // The reservation is DELIBERATELY still spent: the worker settles it. This
    // is the positive control for every refund case below — without it, a
    // `startAgentSession` that refunded unconditionally would pass all of them.
    expect(await balanceOf(userId)).toEqual({ free: 85, paid: 0 });
    if (!outcome.ok) throw new Error('unreachable');
    const session = await findAgentSessionById(db, outcome.sessionId);
    expect(session?.status).toBe('queued');
    expect(session?.creditReservation?.creditsReserved).toBe(15);
  });

  /**
   * The counters follow the ORIGIN, and both halves are asserted.
   *
   * `hireCount` is a marketplace reputation signal: how many people chose this
   * agent. Asserting only the `hire` case would keep passing if `delegation`
   * moved it too, which is the direction that corrupts the number — and
   * asserting only `delegation` would keep passing if nothing counted anything.
   */
  it('counts a chosen hire on both counters', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);

    await startAgentSession({ agent, userId, task: 'chosen', origin: 'hire' });

    const [row] = await db.select().from(agents).where(eq(agents.id, agent._id));
    expect({ hireCount: row?.hireCount, usageCount: row?.usageCount }).toEqual({
      hireCount: 1,
      usageCount: 1,
    });
  });

  it('counts a routed delegation as usage only', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);

    await startAgentSession({ agent, userId, task: 'routed', origin: 'delegation' });

    const [row] = await db.select().from(agents).where(eq(agents.id, agent._id));
    expect({ hireCount: row?.hireCount, usageCount: row?.usageCount }).toEqual({
      hireCount: 0,
      usageCount: 1,
    });
  });

  it('refuses without debiting when the balance will not cover the price', async () => {
    const userId = await account(3, 0);
    const agent = await seedAgent(15);

    const outcome = await startAgentSession({ agent, userId, task: 'too expensive', origin: 'hire' });

    expect(outcome).toEqual({ ok: false, reason: 'insufficient_credits', creditsNeeded: 15 });
    expect(await balanceOf(userId)).toEqual({ free: 3, paid: 0 });
  });

  it('gives the credits back when the ENQUEUE fails', async () => {
    const userId = await account(100, 0);
    const before = await balanceOf(userId);
    const agent = await seedAgent(15);
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    const outcome = await startAgentSession({ agent, userId, task: 'never queued', origin: 'hire' });

    expect(outcome).toEqual({ ok: false, reason: 'handoff_failed' });
    expect(await balanceOf(userId)).toEqual(before);
  });

  /**
   * The insert is refused by the SERVER, not by a stub.
   *
   * `depth` is `integer`, so a value past int4 raises `22003 numeric value out
   * of range` inside the same statement the production path issues. A mocked
   * rejection would prove the `catch` runs; this proves it runs for something
   * the database can actually do — and it leaves the row genuinely unwritten,
   * which is the state the refund path has to handle.
   */
  it('gives the credits back when the SESSION ROW cannot be written', async () => {
    const userId = await account(100, 0);
    const before = await balanceOf(userId);
    const agent = await seedAgent(15);

    const outcome = await startAgentSession({
      agent,
      userId,
      task: 'unwritable',
      origin: 'hire',
      depth: 9_999_999_999,
    });

    expect(outcome).toEqual({ ok: false, reason: 'handoff_failed' });
    expect(await balanceOf(userId)).toEqual(before);
    // Nothing was written, so there is nothing for the sweep to find either.
    expect(await db.select().from(agentSessions).where(eq(agentSessions.agentId, agent._id))).toEqual([]);
  });

  /**
   * The refund goes back to the bucket the reservation came out of.
   *
   * An account whose free allowance is spent funds an agent hire from
   * `credits_paid`, and `refreshFreeCreditsIfDue` overwrites `credits_free` with
   * the daily limit — so a refund into `free` is destroyed within a day.
   */
  it('returns a paid-funded reservation to the paid balance', async () => {
    const userId = await account(0, 100);
    const agent = await seedAgent(15);
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await startAgentSession({ agent, userId, task: 'never queued', origin: 'hire' });

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });

  /**
   * A handoff that fails after the row exists leaves the row CANCELLED.
   *
   * This is what stops the reclaim sweep paying the same reservation a second
   * time: the sweep looks for `queued` rows, and a row this path refunded is not
   * one. The order matters and is asserted by the pair — the cancel lands first,
   * and the refund only happens because it did.
   */
  it('cancels the session row it already wrote, so the sweep cannot pay twice', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await startAgentSession({ agent, userId, task: 'never queued', origin: 'hire' });

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.agentId, agent._id));
    expect(row?.status).toBe('cancelled');

    // ...and the sweep, run over the same row aged past its cutoff, finds
    // nothing to give back: the balance is the refunded one, not twice it.
    await backdate(agent._id);
    await reclaimOrphanedAgentSessions();
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });
});

describe('reclaimOrphanedAgentSessions', () => {
  it('refunds a session that was enqueued and never picked up', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);
    const outcome = await startAgentSession({ agent, userId, task: 'stranded', origin: 'hire' });
    expect(outcome.ok).toBe(true);
    expect(await balanceOf(userId)).toEqual({ free: 85, paid: 0 });

    // A day later, still `queued`: no worker ever claimed it.
    await backdate(agent._id);
    const reclaimed = await reclaimOrphanedAgentSessions();

    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
    if (!outcome.ok) throw new Error('unreachable');
    expect((await findAgentSessionById(db, outcome.sessionId))?.status).toBe('failed');
  });

  /**
   * The claim is the UPDATE, so a second sweep pays nothing.
   *
   * Two API tasks boot at once and both run this. If the read and the refund
   * were separate statements, both would read the same `queued` row and both
   * would refund it. Calling it twice in a row is the cheapest version of that
   * race that a single-connection test can express, and it is the one that
   * distinguishes a claiming UPDATE from a SELECT-then-refund.
   */
  it('is idempotent: a second sweep over the same rows refunds nothing', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);
    await startAgentSession({ agent, userId, task: 'stranded', origin: 'hire' });

    await backdate(agent._id);
    await reclaimOrphanedAgentSessions();
    const afterFirst = await balanceOf(userId);
    await reclaimOrphanedAgentSessions();

    expect(await balanceOf(userId)).toEqual(afterFirst);
    expect(afterFirst).toEqual({ free: 100, paid: 0 });
  });

  it('leaves a freshly queued session alone', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);
    await startAgentSession({ agent, userId, task: 'just queued', origin: 'hire' });

    // The real cutoff, not a fabricated one: a session queued seconds ago is
    // not orphaned and must keep its reservation for the worker.
    await reclaimOrphanedAgentSessions();

    expect(await balanceOf(userId)).toEqual({ free: 85, paid: 0 });
  });

  it('leaves a session that took NO credits alone', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);
    // Sub-sessions created by the executor pool carry no reservation.
    const session = await createAgentSession(getDb(), {
      agentId: agent._id,
      oxyUserId: userId,
      task: 'no reservation',
      status: 'queued',
      depth: 1,
    });

    await backdate(agent._id);
    await reclaimOrphanedAgentSessions();

    // Marked failed like the rest — it is just as stranded — but nothing was
    // reserved, so nothing is given back.
    expect((await findAgentSessionById(db, session._id))?.status).toBe('failed');
    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });
});

/**
 * What stops the sweep and a late worker BOTH settling one reservation.
 *
 * The sweep refunds a session whose job never arrived — but a job is not
 * destroyed by being slow. If every worker were down for an hour and then came
 * back, Redis would still hold the job and hand it to `runAgentSession` after
 * the sweep had already given the credits back. Refund plus charge is the
 * double settle this whole file exists to avoid.
 *
 * It cannot happen, and the reason is one predicate in the runner: it reads the
 * row first and returns without doing anything when the status is terminal. The
 * sweep writes `failed`, which is in that set — so the interlock is that the two
 * agree on a specific word, in two files, with nothing that would fail if they
 * stopped agreeing. Hence this: it asserts the word, not the mechanism.
 *
 * Read from source because importing `runAgentSession` pulls in the container
 * host, the browser session and the terminal sandbox.
 */
describe('the reclaim sweep and a late worker cannot both settle', () => {
  const runnerSource = readFileSync(
    fileURLToPath(new URL('../runner.ts', import.meta.url)),
    'utf8',
  );

  it('the runner declines exactly the status the sweep writes', () => {
    // Vacuity floor: a mistyped path, an empty read or a moved guard all print
    // the same "not found" as a real regression.
    expect(runnerSource.length).toBeGreaterThan(1000);
    expect(runnerSource).toContain('export async function runAgentSession');

    expect(runnerSource).toContain(
      "if (session.status === 'cancelled' || session.status === 'completed' || session.status === 'failed') {",
    );
  });

  it('and the sweep really does write that status', async () => {
    const userId = await account(100, 0);
    const agent = await seedAgent(15);
    const outcome = await startAgentSession({ agent, userId, task: 'stranded', origin: 'hire' });
    if (!outcome.ok) throw new Error('the balance covers 15; the handoff must succeed');

    await backdate(agent._id);
    await reclaimOrphanedAgentSessions();

    // The other half of the pair. Asserting the runner's guard alone would keep
    // passing if the sweep started writing 'queued' back, or 'running'.
    expect((await findAgentSessionById(db, outcome.sessionId))?.status).toBe('failed');
  });
});
