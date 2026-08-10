import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { acquireOrRenewLease, releaseLease } from '../coordination/leaseRepository';
import { leases } from '../schema/leases';

/**
 * Leader election through the REPOSITORY, against a real server.
 *
 * `schema.pgdb.test.ts` already asserts these properties against a hand-written
 * statement, which establishes that the TABLE can express them. This file
 * asserts them against the code that actually ships, which is a different claim:
 * a repository emitting a subtly different statement — a missing `setWhere`, an
 * `acquired_at` that resets on every renewal — would leave that suite green and
 * elect two leaders in production.
 *
 * Lease names are namespaced `lease-repo-*` because the pgdb suite shares ONE
 * database across every file and `leases.name` is the primary key; an
 * unqualified `election-1` here would collide with that other file's fixtures.
 */

let db: ApiDatabase;

const HOLDER_A = 'task-a';
const HOLDER_B = 'task-b';
const TTL_MS = 60_000;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/**
 * The stored row — read independently of the repository, so a broken write
 * cannot be hidden by the same code that made it.
 *
 * Through the query BUILDER rather than `db.execute`: drizzle's `mode: 'date'`
 * mapping is applied by the result mapper, which raw SQL does not go through, so
 * `db.execute` hands back the driver's `timestamptz` STRING while the column is
 * typed `Date` either way. Every instant assertion below would then be comparing
 * strings and `getTime()` would not exist.
 */
async function readLease(name: string) {
  const [row] = await db.select().from(leases).where(eq(leases.name, name));
  // Throws rather than returning `undefined`: every caller here needs the row,
  // and a missing one is a failed write, not a value to thread through.
  if (!row) throw new Error(`lease '${name}' has no row`);
  return row;
}

/** Make an existing lease look like a dead holder's, WITHOUT waiting out a real TTL. */
function expireLease(name: string) {
  return db.execute(sql`update ${leases} set expires_at = now() - interval '1 second' where name = ${name}`);
}

describe('acquiring and renewing', () => {
  it('claims a lease that does not exist yet', async () => {
    const name = 'lease-repo-fresh';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);

    // Positive control: "true" must correspond to a row that is really there.
    // Without this, a repository that returned true and wrote nothing passes.
    const row = await readLease(name);
    expect(row.holderId).toBe(HOLDER_A);
  });

  it('refuses a second instance while the lease is LIVE', async () => {
    const name = 'lease-repo-contended';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);

    // The whole point of the `setWhere`. Drop it and this returns true.
    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(false);

    // And the refusal must be a NO-OP, not a partial write: the incumbent's row
    // is untouched. A `DO UPDATE` without the predicate would have moved
    // `holder_id` here even though the caller was told it lost.
    expect((await readLease(name)).holderId).toBe(HOLDER_A);
  });

  it('lets the SAME instance renew, extending expiry but preserving acquired_at', async () => {
    const name = 'lease-repo-renew';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    const first = await readLease(name);

    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS * 2)).toBe(true);
    const second = await readLease(name);

    // `acquired_at` answers "how long has this task been leader" and must
    // survive a renewal — a `CASE` comparing against the wrong side resets it
    // every heartbeat, which reads as leadership flapping in the logs.
    expect(second.acquiredAt).toEqual(first.acquiredAt);
    // ...while the claim itself really was extended.
    expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    // `$onUpdate` does not fire inside an insert's conflict clause, so the
    // repository has to set this itself.
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it('lets a successor take over once the holder stops renewing, and RESETS acquired_at', async () => {
    const name = 'lease-repo-takeover';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    const before = await readLease(name);

    await expireLease(name);

    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(true);
    const after = await readLease(name);
    expect(after.holderId).toBe(HOLDER_B);
    // Leadership genuinely changed hands, so this is a NEW tenure.
    expect(after.acquiredAt.getTime()).toBeGreaterThan(before.acquiredAt.getTime());
  });

  it('derives expiry from the SERVER clock, not the caller\'s', async () => {
    const name = 'lease-repo-clock';
    await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS);
    const row = await readLease(name);

    // Both instants come from the same `now()` in one statement, so the gap is
    // EXACTLY the TTL. A caller-supplied `Date` on either side would make this
    // drift by the client/server clock skew plus a round trip.
    expect(row.expiresAt.getTime() - row.acquiredAt.getTime()).toBe(TTL_MS);
  });
});

describe('releasing', () => {
  it('lets a successor take over immediately', async () => {
    const name = 'lease-repo-release';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    // Before the release, B cannot have it — otherwise the assertion after the
    // release would pass whether or not `releaseLease` did anything at all.
    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(false);

    await releaseLease(db, name, HOLDER_A);

    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(true);
  });

  it('ignores a release from an instance that no longer holds it', async () => {
    const name = 'lease-repo-stale-release';
    await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS);
    await expireLease(name);
    await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS);

    // A slow shutdown on the OLD holder must not hand B's live lease away.
    await releaseLease(db, name, HOLDER_A);

    const row = await readLease(name);
    expect(row.holderId).toBe(HOLDER_B);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
