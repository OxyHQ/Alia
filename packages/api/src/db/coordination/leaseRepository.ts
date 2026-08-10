/**
 * Leader-election leases, on Postgres.
 *
 * One statement does the work, and the shape of its RESULT is the answer:
 * `acquireOrRenewLease` returns a row when this instance holds the lease and no
 * row when another instance holds a live one. There is no second read deciding
 * afterwards, because a second read is a second instant — and two ECS tasks
 * racing at that seam is the only failure this table exists to prevent.
 *
 * ## Why one `INSERT … ON CONFLICT DO UPDATE … WHERE`
 *
 * Mongo did it with an aggregation-pipeline upsert filtered on
 * `holderId == me OR expiresAt < $$NOW`, evaluated server-side. The Postgres
 * equivalent is not "select then update": that is two statements, needs a
 * transaction to be atomic, and still has to decide what to do when the row does
 * not exist yet. `ON CONFLICT` handles the first-boot insert and the steady-state
 * renewal with the same statement, and the `WHERE` on `DO UPDATE` is what makes a
 * losing attempt a genuine no-op rather than a theft.
 *
 * When the `WHERE` is false, Postgres updates nothing and `RETURNING` yields
 * NOTHING — the empty result IS "somebody else holds it". That matters: a
 * failure still propagates as an exception, so "not the leader" and "the database
 * is unreachable" stay distinguishable. Collapsing them is how a network blip
 * turns into two leaders.
 *
 * ## The clock is the SERVER's, always
 *
 * Every instant here is `now()` evaluated by Postgres. Nothing binds a JavaScript
 * `Date`, and nothing compares against one. Two ECS tasks whose clocks disagree
 * by more than the lease TTL would otherwise both believe they hold it, which is
 * precisely the thing being prevented — and a bound `Date` would also be the
 * caller's clock wearing the server's authority.
 *
 * Stored instants are truncated to millisecond precision to match `@oxyhq/db`'s
 * `createdAt`/`updatedAt` defaults; a `timestamptz` carries microseconds a JS
 * `Date` cannot hold, so an untruncated write does not survive the round trip.
 * The expiry PREDICATE compares against a bare `now()` — it is a comparison, not
 * a stored value, and sub-millisecond precision there is free.
 */

import { sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { leases } from '../schema/leases';

/** `now()` at the precision a JavaScript `Date` can hold — see the module comment. */
const serverNow = sql`date_trunc('milliseconds', now())`;

/**
 * Claim `name` for `holderId`, or renew it if this instance already holds it.
 *
 * @returns `true` when this instance holds the lease afterwards, `false` when
 *   another instance holds a live one. Throws if the database cannot be reached
 *   — never conflated with `false`.
 */
export async function acquireOrRenewLease(
  db: ApiDatabase,
  name: string,
  holderId: string,
  leaseTtlMs: number,
): Promise<boolean> {
  const expiresAt = sql`${serverNow} + (${leaseTtlMs} * interval '1 millisecond')`;

  const rows = await db
    .insert(leases)
    .values({
      name,
      holderId,
      expiresAt,
      acquiredAt: serverNow,
    })
    .onConflictDoUpdate({
      target: leases.name,
      set: {
        holderId,
        expiresAt,
        /**
         * Preserved across renewals by the SAME holder, reset only when
         * leadership actually changes hands. In a `DO UPDATE SET` value the
         * unqualified table reference is the EXISTING row, so this reads the
         * stored holder, not the one being proposed.
         */
        acquiredAt: sql`case when ${leases.holderId} = ${holderId} then ${leases.acquiredAt} else ${serverNow} end`,
        /**
         * Set explicitly: `$onUpdate` is applied by `db.update()`, and this is an
         * insert's conflict clause, so the builder would not touch it.
         */
        updatedAt: serverNow,
      },
      /**
       * The whole election, in one predicate: take it if it is already mine, or
       * if the previous holder's claim has lapsed. Anything else updates no row.
       */
      setWhere: sql`${leases.holderId} = ${holderId} or ${leases.expiresAt} < now()`,
    })
    .returning({ holderId: leases.holderId });

  return rows.length > 0;
}

/**
 * Give up `name` if this instance holds it, so a successor can take over
 * immediately instead of waiting out the remaining TTL.
 *
 * Expiring the row rather than deleting it keeps `acquired_at` readable for the
 * next holder to overwrite and keeps the primary key stable, which is what makes
 * the acquire statement above an UPDATE rather than a race between two inserts.
 *
 * The `holder_id` predicate is what stops a shutting-down instance releasing a
 * lease another instance has already taken over.
 */
export async function releaseLease(
  db: ApiDatabase,
  name: string,
  holderId: string,
): Promise<void> {
  await db
    .update(leases)
    .set({ expiresAt: sql`'epoch'::timestamptz` })
    .where(sql`${leases.name} = ${name} and ${leases.holderId} = ${holderId}`);
}
