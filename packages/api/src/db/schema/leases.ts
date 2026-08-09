/**
 * Leader election.
 *
 * This is the one table in the first batch with NO Mongoose model: it is reached
 * through `mongoose.connection.collection('leases')` in `lib/leader-election.ts`,
 * so a model-based inventory of what to port cannot see it at all. It is here
 * first for exactly that reason — it is the shape most likely to be forgotten,
 * and the only one whose absence would be discovered by two ECS tasks running
 * the trigger engine at once.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * One row per named lease. The lease NAME is the primary key, exactly as `_id`
 * was under Mongo — `startLeaderElection('trigger-engine')` addresses it by name
 * and there is nothing else to identify it by. A surrogate id would be an
 * indirection with a unique index on the real key beside it.
 *
 * `holder_id` is the instance that currently holds it and `expires_at` is when
 * the claim lapses. Acquire and renew are ONE conditional statement — claim if
 * the row is mine or the existing claim has expired — so two tasks racing
 * produce one winner without a transaction, which is what the Mongo version
 * achieved with an aggregation-pipeline update evaluating `$$NOW` server-side.
 *
 * The clock must stay the SERVER's (`now()`), not the application's. Two ECS
 * tasks whose clocks disagree by more than the lease TTL would otherwise both
 * believe they hold it, which is the one failure this table exists to prevent.
 */
export const leases = pgTable('leases', {
  name: text().primaryKey(),
  holderId: text().notNull(),
  /** When the current claim lapses. Compared against `now()`, never a JS Date. */
  expiresAt: timestamptz().notNull(),
  /**
   * When leadership last CHANGED HANDS — preserved across renewals by the same
   * holder, reset only when a different instance takes over. It is diagnostic
   * (how long has this task been leader?) and is deliberately not part of the
   * acquire predicate.
   */
  acquiredAt: timestamptz().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
