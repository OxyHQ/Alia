/**
 * Leader election.
 *
 * `lib/leader-election.ts` elects one leader across several ECS tasks through
 * this table; without it, two tasks would run the trigger engine at once.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from '@oxy.so/db';

/**
 * One row per named lease. The lease NAME is the primary key —
 * `startLeaderElection('trigger-engine')` addresses it by name
 * and there is nothing else to identify it by. A surrogate id would be an
 * indirection with a unique index on the real key beside it.
 *
 * `holder_id` is the instance that currently holds it and `expires_at` is when
 * the claim lapses. Acquire and renew are ONE conditional statement — claim if
 * the row is mine or the existing claim has expired — so two tasks racing
 * produce one winner without a transaction.
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
