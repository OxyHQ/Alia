import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentSessions } from '../schema/agent-sessions';
import { createAgent } from '../agents/agentRepository';
import {
  claimAgentSessionRun,
  createAgentSession,
  failExhaustedAgentSessionRun,
  listLapsedAgentSessionRuns,
  releaseAgentSessionRunLease,
  renewAgentSessionRunLease,
  RUNNER_LEASE_MS,
  RUNNER_MAX_ATTEMPTS,
} from '../agents/agentSessionRepository';

/**
 * Ownership of a background agent run, against a REAL server.
 *
 * The claim is one conditional UPDATE, and every property below is a property
 * of that statement under concurrency and time — which is exactly what a mock
 * cannot say: two claims racing, a lease that lapses, a renewal by a worker
 * that no longer owns the row.
 */

let db: ApiDatabase;
const OWNER = `oxy-lease-${Math.random().toString(36).slice(2, 10)}`;
const suffix = () => Math.random().toString(36).slice(2, 10);

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

async function seedSession(overrides: Record<string, unknown> = {}) {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-lease-${suffix()}`,
    ownerOxyAccountId: OWNER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: OWNER,
    category: 'research',
    routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
  });
  return createAgentSession(db, { agentId: agent._id, oxyUserId: OWNER, task: 'work', status: 'queued', ...overrides });
}

const later = (ms: number) => new Date(Date.now() + ms);

describe('claiming a background run', () => {
  it('lets exactly one of two racing workers win', async () => {
    const session = await seedSession();

    const [a, b] = await Promise.all([
      claimAgentSessionRun(db, session._id, 'worker-a'),
      claimAgentSessionRun(db, session._id, 'worker-b'),
    ]);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, session._id));
    expect(row?.status).toBe('running');
    expect(row?.runnerAttempts).toBe(1);
    expect(['worker-a', 'worker-b']).toContain(row?.runnerLeaseOwner);
  });

  it('refuses a live lease and takes a lapsed one, counting the attempt', async () => {
    const session = await seedSession();
    expect((await claimAgentSessionRun(db, session._id, 'first')).claimed).toBe(true);
    expect((await claimAgentSessionRun(db, session._id, 'second')).claimed).toBe(false);

    const afterLapse = later(RUNNER_LEASE_MS + 1_000);
    const resumed = await claimAgentSessionRun(db, session._id, 'second', afterLapse);
    expect(resumed).toMatchObject({ claimed: true, attempt: 2 });
  });

  it('never takes a settled run or a synchronous chat turn', async () => {
    const settled = await seedSession({ status: 'completed' });
    expect((await claimAgentSessionRun(db, settled._id, 'w')).claimed).toBe(false);

    const chat = await seedSession({ status: 'running', chatLeaseExpiresAt: later(-60_000) });
    expect((await claimAgentSessionRun(db, chat._id, 'w')).claimed).toBe(false);
  });

  it('carries the persisted counters a resume continues from', async () => {
    const session = await seedSession();
    await db.update(agentSessions).set({ statsTotalSteps: 7, statsTotalTokens: 1234 }).where(eq(agentSessions.id, session._id));

    const claim = await claimAgentSessionRun(db, session._id, 'w');
    expect(claim.claimed && claim.session.stats).toMatchObject({ totalSteps: 7, totalTokens: 1234 });
  });
});

describe('holding and losing a run', () => {
  it('renews only for its owner, and release drops only its own lease', async () => {
    const session = await seedSession();
    await claimAgentSessionRun(db, session._id, 'owner');

    expect(await renewAgentSessionRunLease(db, session._id, 'owner')).toBe(true);
    expect(await renewAgentSessionRunLease(db, session._id, 'intruder')).toBe(false);

    await releaseAgentSessionRunLease(db, session._id, 'intruder');
    let [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, session._id));
    expect(row?.runnerLeaseOwner).toBe('owner');

    await releaseAgentSessionRunLease(db, session._id, 'owner');
    [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, session._id));
    expect(row?.runnerLeaseOwner).toBeNull();
    expect(row?.runnerLeaseExpiresAt).toBeNull();
  });

  it('tells a worker whose lease was taken over that the run is no longer its', async () => {
    const session = await seedSession();
    await claimAgentSessionRun(db, session._id, 'dead-worker');
    await claimAgentSessionRun(db, session._id, 'new-worker', later(RUNNER_LEASE_MS + 1_000));

    expect(await renewAgentSessionRunLease(db, session._id, 'dead-worker')).toBe(false);
  });

  it('lists a lapsed run for the reaper, and not a live one', async () => {
    const live = await seedSession();
    const dead = await seedSession();
    await claimAgentSessionRun(db, live._id, 'w');
    await claimAgentSessionRun(db, dead._id, 'w', later(-RUNNER_LEASE_MS - 1_000));

    const lapsed = (await listLapsedAgentSessionRuns(db, new Date(), 10_000)).map((run) => run.id);
    expect(lapsed).toContain(dead._id);
    expect(lapsed).not.toContain(live._id);
  });

  it('fails a run only once it has exhausted its attempts, and returns it to one caller', async () => {
    const session = await seedSession();
    const past = later(-RUNNER_LEASE_MS - 1_000);
    await claimAgentSessionRun(db, session._id, 'w', past);
    expect(await failExhaustedAgentSessionRun(db, session._id)).toBeNull();

    await db.update(agentSessions).set({ runnerAttempts: RUNNER_MAX_ATTEMPTS }).where(eq(agentSessions.id, session._id));
    const [first, second] = await Promise.all([
      failExhaustedAgentSessionRun(db, session._id),
      failExhaustedAgentSessionRun(db, session._id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, session._id));
    expect(row?.status).toBe('failed');
  });
});
