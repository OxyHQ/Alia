import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * `handleRoutingDecision`, against a REAL Postgres server, for the credits.
 *
 * A `task_router` agent that decides to delegate to another agent HIRES it with
 * the trigger owner's credits. The delegation reserved the target's price and
 * then created a session and enqueued a job inside a `try` whose `catch` only
 * logged — so a failure of either left the owner short by fifteen credits for an
 * agent that never ran. Nothing surfaced it: a routing decision has no HTTP
 * response, so the log line was the only trace and the balance was simply lower.
 *
 * Every assertion here is about the BALANCE. A test on the routing log or the
 * session row passes against the code that leaks.
 */

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, triggers: child, chat: child, general: child, v1: child, credits: child, providers: child } };
});
vi.mock('../../chat-core.js', () => ({
  getAliaModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));
vi.mock('../../task-queue.js', () => ({
  enqueueAgentSession: vi.fn(async () => ({ queued: true, jobId: 'job-1' })),
}));
vi.mock('../../notification-service.js', () => ({ sendNotification: vi.fn(async () => undefined) }));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { userCredits } from '../../../db/schema/billing.js';
import { agentSessions } from '../../../db/schema/agent-sessions.js';
import { agents } from '../../../db/schema/agents.js';
import { createAgent, type AgentRecord } from '../../../db/agents/agentRepository.js';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository.js';
import type { TriggerRecord } from '../../../db/automation/triggerRepository.js';
import { enqueueAgentSession } from '../../task-queue.js';
import { handleRoutingDecision } from '../routing-handler.js';
import type { HydratedAgent } from '../../agent-identity.js';

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

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `routing-${process.pid}`;
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
 * `handleRoutingDecision` takes a HYDRATED router agent, because it writes that
 * agent's display name into the routed task. Identity is Oxy's, so a record
 * alone is no longer enough — the three fields are attached here with the
 * fallbacks a real unresolvable account would produce.
 */
function hydrated(agent: AgentRecord): HydratedAgent {
  return { ...agent, name: 'Target', handle: 'target', color: null, authorName: null };
}

async function seedAgent(): Promise<AgentRecord> {
  return createAgent(db, {
    oxyAccountId: `oxy-bot-routing-${SUITE}-${seq++}`,
    tagline: 'does the work',
    description: 'd',
    authorOxyUserId: SUITE,
    category: 'research',
    price: 15,
    isPublished: true,
  });
}

function trigger(userId: string): TriggerRecord {
  return {
    _id: `${SUITE}-trigger-${seq++}`,
    oxyUserId: userId,
    type: 'schedule',
  } as TriggerRecord;
}

/** The router agent's answer, in the shape `parseRoutingDecision` reads. */
function decisionDelegatingTo(target: AgentRecord): string {
  return JSON.stringify({
    category: 'support',
    priority: 'high',
    confidence: 0.9,
    assignTo: { type: 'agent', id: target._id, name: 'Target' },
    reasoning: 'the target handles these',
    summary: 'a customer is waiting',
  });
}

describe('handleRoutingDecision — delegating to an agent', () => {
  it('leaves the price reserved when the delegation succeeds', async () => {
    const userId = await account(100, 0);
    const router = await seedAgent();
    const target = await seedAgent();

    await handleRoutingDecision(hydrated(router), decisionDelegatingTo(target), trigger(userId));

    // The worker settles it. This is the positive control: an implementation
    // that refunded unconditionally would pass every case below and fail here.
    expect(await balanceOf(userId)).toEqual({ free: 85, paid: 0 });
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.agentId, target._id));
    expect(rows.map((row) => row.status)).toEqual(['queued']);
  });

  it('gives the price back when the ENQUEUE fails', async () => {
    const userId = await account(100, 0);
    const router = await seedAgent();
    const target = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await handleRoutingDecision(hydrated(router), decisionDelegatingTo(target), trigger(userId));

    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
    // ...and leaves nothing `queued` for the reclaim sweep to pay a second time.
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.agentId, target._id));
    expect(rows.map((row) => row.status)).toEqual(['cancelled']);
  });

  it('gives a paid-funded price back to the PAID balance', async () => {
    const userId = await account(0, 100);
    const router = await seedAgent();
    const target = await seedAgent();
    vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('redis is gone'));

    await handleRoutingDecision(hydrated(router), decisionDelegatingTo(target), trigger(userId));

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });

  /**
   * A routed delegation counts as USE of the target agent, and NOT as a hire.
   *
   * `hireCount` is a marketplace reputation signal — how many people chose this
   * agent. A `task_router` sending it work on a trigger is real usage, but
   * nobody chose it, so counting it there inflates the number with internal
   * traffic. It also stops meaning one thing: "hire" is becoming membership in
   * an account graph rather than a one-off purchase, and a counter carrying both
   * senses cannot be separated back out afterwards.
   */
  it('counts the delegation as USAGE but not as a hire', async () => {
    const userId = await account(100, 0);
    const router = await seedAgent();
    const target = await seedAgent();

    await handleRoutingDecision(hydrated(router), decisionDelegatingTo(target), trigger(userId));

    const [row] = await db.select().from(agents).where(eq(agents.id, target._id));
    expect({ hireCount: row?.hireCount, usageCount: row?.usageCount }).toEqual({
      hireCount: 0,
      usageCount: 1,
    });
  });

  it('debits nothing, and writes no session, when the owner cannot afford the target', async () => {
    const userId = await account(3, 0);
    const router = await seedAgent();
    const target = await seedAgent();

    await handleRoutingDecision(hydrated(router), decisionDelegatingTo(target), trigger(userId));

    expect(await balanceOf(userId)).toEqual({ free: 3, paid: 0 });
    expect(await db.select().from(agentSessions).where(eq(agentSessions.agentId, target._id))).toEqual([]);
  });
});
