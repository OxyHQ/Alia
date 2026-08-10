import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ApiDatabase } from '../../db/index.js';
import { leases } from '../../db/schema/leases';

/**
 * The election STATE MACHINE, driven by a real Postgres server.
 *
 * `leaseRepository.pgdb.test.ts` covers the statement; this covers what the
 * module does with its answers — that `onElected` fires exactly once, that a
 * displaced leader demotes itself on its next heartbeat, and that `stop()`
 * hands the lease over instead of making a successor wait out the TTL.
 *
 * ## Why this is no longer a mocked test
 *
 * It used to hand-roll an in-memory `leases` collection reproducing Mongo's
 * `$$NOW` semantics — necessarily, since those semantics were the thing under
 * test. Rewriting that mock against Postgres would mean restating this port's
 * own `ON CONFLICT … WHERE` in TypeScript and then testing the restatement: a
 * mutation dropping the `setWhere` from the real statement would leave a mock
 * that still elects one leader. The database is the only thing that can answer
 * whether two instances racing produce one winner.
 *
 * Instances are modelled by re-importing the module after `vi.resetModules()`:
 * each import gets its own random `instanceId`, which is exactly what
 * distinguishes two ECS tasks. They share ONE real connection, because they
 * share one database.
 */

const h = vi.hoisted(() => ({ db: null as ApiDatabase | null }));

/** The same handle, non-nullable, for the test body. Assigned in `beforeAll`. */
let db: ApiDatabase;

vi.mock('../../db/index.js', () => ({
  getDb: () => {
    if (!h.db) throw new Error('Postgres is not connected in this test');
    return h.db;
  },
}));

vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A fresh module instance — a distinct `instanceId`, i.e. a distinct task. */
async function loadInstance() {
  vi.resetModules();
  return import('../leader-election.js');
}

interface Handle {
  isLeader(): boolean;
  stop(): Promise<void>;
}

let closePostgres: () => Promise<void>;

beforeAll(async () => {
  // The REAL module — `vi.mock` above replaced it for everyone else.
  const actual = await vi.importActual<typeof import('../../db/index.js')>('../../db/index.js');
  const connected = actual.connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  h.db = connected;
  db = connected;
  closePostgres = actual.closePostgres;
});

afterAll(async () => {
  h.db = null;
  await closePostgres();
});

describe('leader-election', () => {
  const handles: Handle[] = [];

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)));
    handles.length = 0;
  });

  /** Namespaced per test: the pgdb suite shares one database and `name` is the PK. */
  const leaseName = (suffix: string) => `le-fsm-${suffix}`;

  it('elects exactly one leader when two instances share one lease row', async () => {
    const name = leaseName('one-leader');
    const modA = await loadInstance();
    const modB = await loadInstance();

    const electedA = vi.fn();
    const electedB = vi.fn();
    const handleA = modA.startLeaderElection(name, { onElected: electedA, onDemoted: vi.fn() }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    const handleB = modB.startLeaderElection(name, { onElected: electedB, onDemoted: vi.fn() }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    handles.push(handleA, handleB);

    await wait(200);

    const leaders = (handleA.isLeader() ? 1 : 0) + (handleB.isLeader() ? 1 : 0);
    expect(leaders).toBe(1);
    // Not just "one believes it leads" — the hook fired once across both, so a
    // repeated election (elect, lose, re-elect on every heartbeat) also fails.
    expect(electedA.mock.calls.length + electedB.mock.calls.length).toBe(1);
  });

  it('claims a lease abandoned by a holder that stopped renewing', async () => {
    const name = leaseName('abandoned');
    // A dead predecessor: a foreign holder whose claim lapsed and who is not
    // ticking. Seeded directly because the point is that nobody is renewing it.
    await db.execute(sql`
      insert into ${leases} (name, holder_id, expires_at, acquired_at)
      values (${name}, 'dead-task', now() - interval '1 second', now() - interval '1 hour')
    `);

    const modB = await loadInstance();
    const electedB = vi.fn();
    const handleB = modB.startLeaderElection(name, { onElected: electedB, onDemoted: vi.fn() }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    handles.push(handleB);

    await wait(150);

    expect(handleB.isLeader()).toBe(true);
    expect(electedB).toHaveBeenCalledTimes(1);
  });

  it('demotes a leader whose lease was taken over while it was away', async () => {
    const name = leaseName('demote');
    const modA = await loadInstance();

    const demotedA = vi.fn();
    const handleA = modA.startLeaderElection(name, { onElected: vi.fn(), onDemoted: demotedA }, { heartbeatMs: 10, leaseTtlMs: 60_000 });
    handles.push(handleA);

    await wait(150);
    expect(handleA.isLeader()).toBe(true);

    // What A would come back to after a long pause: a LIVE claim held by someone
    // else. A's next renewal matches neither arm of the predicate.
    await db.execute(sql`
      update ${leases} set holder_id = 'other-task', expires_at = now() + interval '1 hour'
      where name = ${name}
    `);

    await wait(200);

    expect(handleA.isLeader()).toBe(false);
    // Once, not on every subsequent heartbeat.
    expect(demotedA).toHaveBeenCalledTimes(1);
  });

  it('releases the lease on stop()', async () => {
    const name = leaseName('release');
    const modA = await loadInstance();

    const demotedA = vi.fn();
    const handleA = modA.startLeaderElection(name, { onElected: vi.fn(), onDemoted: demotedA }, { heartbeatMs: 10, leaseTtlMs: 60_000 });

    await wait(150);
    expect(handleA.isLeader()).toBe(true);

    await handleA.stop();

    expect(handleA.isLeader()).toBe(false);
    expect(demotedA).toHaveBeenCalledTimes(1);

    // Released leases carry an epoch expiry so any competitor claims immediately.
    const [row] = await db.select().from(leases).where(sql`${leases.name} = ${name}`);
    if (!row) throw new Error(`lease '${name}' has no row after stop()`);
    expect(row.expiresAt.getTime()).toBe(0);
  });
});
