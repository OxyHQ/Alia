import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
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
 *
 * ## No test here waits a fixed time for something to HAPPEN
 *
 * `test:pg` shares one database across every file in the suite, so the round
 * trip a heartbeat takes is not bounded by anything this file controls. A
 * `sleep(150)` standing in for "by now A has been elected" is a bet on how busy
 * the machine is, and when it loses it reports `expected false to be true` —
 * which names the assertion and not the reason. `until()` polls and THROWS with
 * what never happened. Fixed waits survive only where the property genuinely is
 * the passage of time: `settle()`, which asserts that nothing FURTHER happened
 * over a run of heartbeats.
 */

const h = vi.hoisted(() => ({ db: null as ApiDatabase | null }));

/** The same handle, non-nullable, for the test body. Assigned in `beforeAll`. */
let db: ApiDatabase;

/**
 * A SECOND, independent pool — postgres.js directly rather than through the
 * drizzle handle.
 *
 * Only the forced-interleaving test needs it, and it needs two things drizzle
 * does not offer: a connection it can hold a transaction open on across
 * `await`s while the module under test keeps working, and a connection
 * GUARANTEED not to be one of the ones queued behind the lock that transaction
 * holds. `max: 2` is exactly the reserved holder plus the observer that watches
 * for the block.
 */
let observer: postgres.Sql;

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

/** Every handle in this file heartbeats at this rate. */
const HEARTBEAT_MS = 10;

/**
 * Long enough for a dozen heartbeats — the window an "exactly once" assertion
 * needs in order to mean "and not again on every subsequent tick".
 */
const SETTLE_MS = HEARTBEAT_MS * 12;

/** Let the election run on undisturbed, so what comes next reads a settled state. */
const settle = () => wait(SETTLE_MS);

/**
 * Poll until `ready` holds, or throw naming what never happened.
 *
 * The throw is the point. A test that sleeps and then asserts cannot tell "the
 * machine was busy" from "the state machine is broken", and both arrive as the
 * same one-line boolean mismatch on somebody else's branch.
 */
async function until(
  label: string,
  ready: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    await wait(5);
  }
}

/**
 * How many heartbeats are queued behind the backend `holderPid`, transitively.
 *
 * Recursive because row-lock waiters CHAIN: the first blocked upsert waits on
 * the lock holder's transaction, but the second waits on the FIRST one's tuple
 * lock, not on the holder. A one-hop `pg_blocking_pids(pid) @> holderPid` counts
 * exactly 1 no matter how many heartbeats are queued — measured, and it fails
 * as a timeout rather than as a wrong number, which is the only reason it was
 * caught.
 *
 * Scoped to the holder's pid throughout, because `test:pg` shares one database
 * with every other file in the suite.
 */
async function heartbeatsBlockedBehind(holderPid: number): Promise<number> {
  const [row] = await observer<{ waiters: number }[]>`
    with recursive blocked(pid) as (
      select a.pid from pg_stat_activity a
       where ${holderPid} = any(pg_blocking_pids(a.pid))
      union
      select a.pid from pg_stat_activity a
       join blocked b on b.pid = any(pg_blocking_pids(a.pid))
    )
    select count(*)::int as waiters from blocked
  `;
  return row.waiters;
}

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
  observer = postgres(process.env.DATABASE_URL ?? '', { max: 2 });
});

afterAll(async () => {
  h.db = null;
  await observer.end();
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
    const handleA = modA.startLeaderElection(name, { onElected: electedA, onDemoted: vi.fn() }, { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 });
    const handleB = modB.startLeaderElection(name, { onElected: electedB, onDemoted: vi.fn() }, { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 });
    handles.push(handleA, handleB);

    await until('one of the two instances to be elected', () => handleA.isLeader() || handleB.isLeader());
    await settle();

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
    const handleB = modB.startLeaderElection(name, { onElected: electedB, onDemoted: vi.fn() }, { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 });
    handles.push(handleB);

    await until('B to claim the abandoned lease', () => handleB.isLeader());
    await settle();

    expect(handleB.isLeader()).toBe(true);
    // Once across the whole settle window: renewing a lease it already holds is
    // not a re-election.
    expect(electedB).toHaveBeenCalledTimes(1);
  });

  /**
   * The OTHER CI failure, and a different mechanism from the one below.
   *
   * `main`'s run `31450693540` failed `demotes a leader whose lease was taken
   * over while it was away` at `expected false to be true` — its FIRST
   * assertion, before any takeover, where a fixed `wait(150)` ran out before the
   * first heartbeat landed. Nothing to do with the `stop()` race: measured
   * against the FIXED module, main's `wait(150)` shape still fails and the
   * `until()` shape passes.
   *
   * Held here rather than hoped for. The lease row is locked for longer than
   * that whole window, so a RUN of heartbeats blocks — and the part worth
   * pinning is that a pile of blocked renewals all granted at once produces ONE
   * election, not one per heartbeat.
   */
  it('elects once when a run of heartbeats is blocked past any fixed wait', async () => {
    const name = leaseName('slow-first-election');
    // A lapsed claim, so the row EXISTS and the election's upsert conflicts on
    // it. An absent row would not block on a lock at all, and the test would
    // quietly measure nothing.
    await db.execute(sql`
      insert into ${leases} (name, holder_id, expires_at, acquired_at)
      values (${name}, 'dead-task', now() - interval '1 second', now() - interval '1 hour')
    `);

    const holder = await observer.reserve();
    let committed = false;
    try {
      const [pidRow] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const holderPid = pidRow.pid;

      await holder`begin`;
      await holder`select 1 from leases where name = ${name} for update`;

      const modA = await loadInstance();
      const electedA = vi.fn();
      const handleA = modA.startLeaderElection(
        name,
        { onElected: electedA, onDemoted: vi.fn() },
        { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 },
      );
      handles.push(handleA);

      // Two or more, not one: the property is about the PILE, and a single
      // blocked heartbeat would not distinguish "elects once" from "elects".
      await until(
        `a run of heartbeats to queue behind pid ${holderPid}`,
        async () => (await heartbeatsBlockedBehind(holderPid)) >= 2,
      );
      // The block is really holding the election up, so what follows is a
      // recovery and not a race this test happened to win.
      expect(handleA.isLeader()).toBe(false);

      await holder`commit`;
      committed = true;

      await until('the election to land once the block clears', () => handleA.isLeader());
      await settle();
      expect(electedA).toHaveBeenCalledTimes(1);
    } finally {
      if (!committed) await holder`rollback`;
      holder.release();
    }
  });

  it('demotes a leader whose lease was taken over while it was away', async () => {
    const name = leaseName('demote');
    const modA = await loadInstance();

    const demotedA = vi.fn();
    const handleA = modA.startLeaderElection(name, { onElected: vi.fn(), onDemoted: demotedA }, { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 });
    handles.push(handleA);

    await until('A to be elected', () => handleA.isLeader());

    // What A would come back to after a long pause: a LIVE claim held by someone
    // else. A's next renewal matches neither arm of the predicate.
    await db.execute(sql`
      update ${leases} set holder_id = 'other-task', expires_at = now() + interval '1 hour'
      where name = ${name}
    `);

    await until('A to notice the takeover', () => !handleA.isLeader());
    await settle();

    expect(handleA.isLeader()).toBe(false);
    // Once, not on every subsequent heartbeat.
    expect(demotedA).toHaveBeenCalledTimes(1);
  });

  it('releases the lease on stop()', async () => {
    const name = leaseName('release');
    const modA = await loadInstance();

    const demotedA = vi.fn();
    const handleA = modA.startLeaderElection(name, { onElected: vi.fn(), onDemoted: demotedA }, { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 });

    await until('A to be elected', () => handleA.isLeader());

    await handleA.stop();

    expect(handleA.isLeader()).toBe(false);
    expect(demotedA).toHaveBeenCalledTimes(1);

    // Released leases carry an epoch expiry so any competitor claims immediately.
    const [row] = await db.select().from(leases).where(sql`${leases.name} = ${name}`);
    if (!row) throw new Error(`lease '${name}' has no row after stop()`);
    expect(row.expiresAt.getTime()).toBe(0);
  });

  /**
   * The test above, with the interleaving that used to make it intermittent
   * forced to happen every time.
   *
   * `stop()` is called while a renewal is already AT the server. Overlapping
   * calls do not interleave two statements on their own — `Promise.all` only
   * queues them, and whichever the event loop reaches first runs to completion —
   * so the window is opened by holding the lease row in another transaction
   * until both statements are queued behind it, then letting go.
   *
   * Postgres grants the row lock in arrival order, so the renewal lands first,
   * comes back holding the lease, and finds `leader` already set false by a
   * `stop()` that did not wait for it. That is two failures, both observed on
   * `main` under the parallel suite: the handle re-elects ITSELF after being
   * stopped (`isLeader()` true, `onElected` a second time), and — when the
   * release wins the queue instead — the renewal overwrites the epoch expiry
   * with a fresh full-TTL claim, so the successor waits out the whole TTL for a
   * lease belonging to an instance that has gone away.
   */
  it('lets no renewal that was already in flight outlive stop()', async () => {
    const name = leaseName('stop-vs-inflight');
    const modA = await loadInstance();

    const electedA = vi.fn();
    const demotedA = vi.fn();
    const handleA = modA.startLeaderElection(
      name,
      { onElected: electedA, onDemoted: demotedA },
      { heartbeatMs: HEARTBEAT_MS, leaseTtlMs: 60_000 },
    );
    handles.push(handleA);

    await until('A to be elected', () => handleA.isLeader());

    const holder = await observer.reserve();
    let committed = false;
    try {
      const [pidRow] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const holderPid = pidRow.pid;

      // Hold A's own lease row, so A's next heartbeat blocks mid-statement.
      await holder`begin`;
      await holder`select 1 from leases where name = ${name} for update`;

      // The precondition, asserted rather than assumed. Without a genuine block
      // there is no in-flight renewal and the rest of this test proves nothing —
      // it would pass against the very bug it exists to catch.
      await until(
        `a heartbeat to block on the lease row held by pid ${holderPid}`,
        async () => (await heartbeatsBlockedBehind(holderPid)) > 0,
      );

      // `stop()` clears the interval synchronously, so what is in flight at this
      // line is all there will ever be.
      const stopping = handleA.stop();
      await holder`commit`;
      committed = true;
      await stopping;

      expect(handleA.isLeader()).toBe(false);
      // The elected hook fired for the ORIGINAL election and never again. A
      // renewal landing after `stop()` re-elects a stopped handle, which is the
      // same defect seen from the hooks' side.
      expect(electedA).toHaveBeenCalledTimes(1);
      expect(demotedA).toHaveBeenCalledTimes(1);

      const [row] = await db.select().from(leases).where(sql`${leases.name} = ${name}`);
      if (!row) throw new Error(`lease '${name}' has no row after stop()`);
      expect(row.expiresAt.getTime()).toBe(0);
    } finally {
      // The escape hatch for a throw before the commit, so a failed assertion
      // cannot leave a lease row locked and turn one red into a suite-wide hang.
      if (!committed) await holder`rollback`;
      holder.release();
    }
  });
});
