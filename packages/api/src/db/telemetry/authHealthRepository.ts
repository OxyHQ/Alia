/**
 * Auth health counters, on Postgres.
 *
 * One row per `(method, hour)` bucket, incremented on every authentication
 * attempt. The Mongo version was `updateOne(..., { upsert: true })` with `$inc`;
 * the Postgres equivalent is `ON CONFLICT DO UPDATE` adding to the stored value,
 * which is the same atomic read-modify-write done by the server rather than the
 * application. Two tasks authenticating at once must not lose a count.
 *
 * ## The increment is SQL, not JavaScript
 *
 * `successes = auth_health_metrics.successes + 1` is evaluated by Postgres
 * against the stored row. Reading the count into JS and writing back
 * `value + 1` would be a lost update under concurrency — and would also hit the
 * `int8`-decodes-as-a-string trap if the column were ever widened, since
 * `"7" + 1` is `"71"`. Neither problem exists if the arithmetic never leaves the
 * database. These are `integer` today, so only the first applies; the shape is
 * chosen so the second cannot appear later.
 */

import { gte, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { authHealthMetrics } from '../schema/telemetry';

/** The hour bucket a moment falls in — the unique key's second half. */
export function bucketedHour(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
}

/** Add one to this bucket's success count, creating the bucket if needed. */
export async function incrementAuthSuccess(
  db: ApiDatabase,
  method: string,
  hour: Date,
): Promise<void> {
  await db
    .insert(authHealthMetrics)
    .values({ method, hour, successes: 1 })
    .onConflictDoUpdate({
      target: [authHealthMetrics.method, authHealthMetrics.hour],
      set: {
        successes: sql`${authHealthMetrics.successes} + 1`,
        updatedAt: sql`date_trunc('milliseconds', now())`,
      },
    });
}

/**
 * Add one to this bucket's failure count and record the reason.
 *
 * `lastFailureReason` is only overwritten when a reason is supplied, matching
 * the source's conditional `$set` — a later failure with no reason must not
 * erase the last one that had one.
 */
export async function incrementAuthFailure(
  db: ApiDatabase,
  method: string,
  hour: Date,
  now: Date,
  reason?: string,
): Promise<void> {
  await db
    .insert(authHealthMetrics)
    .values({ method, hour, failures: 1, lastFailure: now, lastFailureReason: reason ?? null })
    .onConflictDoUpdate({
      target: [authHealthMetrics.method, authHealthMetrics.hour],
      set: {
        failures: sql`${authHealthMetrics.failures} + 1`,
        lastFailure: now,
        ...(reason ? { lastFailureReason: reason } : {}),
        updatedAt: sql`date_trunc('milliseconds', now())`,
      },
    });
}

export interface AuthHealthGroup {
  readonly method: string;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly lastFailure: Date | null;
  readonly lastFailureReason: string | null;
}

/**
 * Per-method totals since `since`, one row per method.
 *
 * ## `lastFailureReason` is the reason from the MOST RECENT failure
 *
 * The Mongo pipeline used `$last: '$lastFailureReason'` with no preceding
 * `$sort`, so it returned whichever document the group happened to end on —
 * arbitrary, and not necessarily the newest. There is no Postgres equivalent of
 * that, and porting arbitrariness faithfully is not an option, so this picks the
 * reason belonging to the row with the greatest `last_failure`, which is what
 * the field is read as meaning everywhere it is displayed.
 *
 * A deliberate behaviour change, called out because it is one: the value can now
 * differ from what Mongo returned for the same data, and it differs by being
 * correct.
 */
export async function summariseAuthHealth(
  db: ApiDatabase,
  since: Date,
): Promise<AuthHealthGroup[]> {
  const rows = await db
    .select({
      method: authHealthMetrics.method,
      totalSuccesses: sql<number>`coalesce(sum(${authHealthMetrics.successes}), 0)::int`,
      totalFailures: sql<number>`coalesce(sum(${authHealthMetrics.failures}), 0)::int`,
      lastFailure: sql<Date | null>`max(${authHealthMetrics.lastFailure})`,
      /**
       * `DISTINCT ON` would need its own query; this reads the reason off the
       * row holding the maximum `last_failure`. `NULLS LAST` matters: without
       * it a row that never failed sorts FIRST under `DESC` and the reason
       * comes back null for a method that does have failures.
       */
      lastFailureReason: sql<string | null>`(
        array_agg(${authHealthMetrics.lastFailureReason} ORDER BY ${authHealthMetrics.lastFailure} DESC NULLS LAST)
      )[1]`,
    })
    .from(authHealthMetrics)
    .where(gte(authHealthMetrics.hour, since))
    .groupBy(authHealthMetrics.method)
    .orderBy(authHealthMetrics.method);

  return rows.map((r) => ({
    method: r.method,
    totalSuccesses: r.totalSuccesses,
    totalFailures: r.totalFailures,
    lastFailure: r.lastFailure,
    lastFailureReason: r.lastFailureReason,
  }));
}
