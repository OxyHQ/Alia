/**
 * Fallback-engine diagnostics, on Postgres.
 *
 * One row per request that went through the fallback engine, plus the admin
 * panel's aggregations over them. Rows are swept at 30 days by
 * `db/expiryTargets.ts` — Mongo had a TTL index on `timestamp` and Postgres has
 * no such thing, so the registry entry IS the retention.
 *
 * ## Every aggregate is cast at the boundary
 *
 * `count(*)` is `bigint` and `avg(integer)` is `numeric`, and postgres.js decodes
 * both as STRINGS while drizzle types them `number`. A total that arrives as
 * `"7"` survives every comparison a test is likely to make and turns the first
 * arithmetic into string concatenation. So every aggregate below ends in an
 * explicit `::int` or `::double precision`, and the test asserts `typeof`.
 *
 * ## `attempts` is `jsonb`, so `$unwind` is `jsonb_array_elements`
 *
 * The Mongo pipelines unwound the per-attempt sub-documents to group across
 * them. The Postgres equivalent is a lateral `jsonb_array_elements`, which is
 * why the two "across all attempts" reads join the table to itself-per-element
 * rather than reading a child table: `attempts` has no identity of its own and
 * is never addressed except whole or unwound.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { fallbackEvents } from '../schema/telemetry';

export interface FallbackAttemptRecord {
  readonly provider: string;
  readonly model: string;
  readonly error: string;
  readonly reason: string;
  readonly latencyMs: number;
}

export interface NewFallbackEvent {
  readonly timestamp: Date;
  readonly aliasModel: string;
  readonly attempts: FallbackAttemptRecord[];
  readonly finalProvider: string | null;
  readonly finalModel: string | null;
  readonly success: boolean;
  readonly totalLatencyMs: number;
}

/** Append one event. Fire-and-forget at the call site; this still rejects. */
export async function recordFallbackEvent(db: ApiDatabase, event: NewFallbackEvent): Promise<void> {
  await db.insert(fallbackEvents).values({
    timestamp: event.timestamp,
    aliasModel: event.aliasModel,
    attempts: event.attempts,
    finalProvider: event.finalProvider,
    finalModel: event.finalModel,
    success: event.success,
    totalLatencyMs: event.totalLatencyMs,
  });
}

export interface FallbackSummary {
  readonly totalEvents: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly avgTotalLatencyMs: number;
  readonly avgAttempts: number;
  readonly maxAttempts: number;
}

/**
 * Totals over the window.
 *
 * Always exactly one row: an aggregate with no `GROUP BY` over an empty set
 * still returns a row, of zeros and nulls. The Mongo pipeline returned an EMPTY
 * array in that case and the route substituted a zeroed object, so the values
 * the caller sees are the same either way — but the caller no longer needs the
 * substitution, and "no rows" no longer has to be told apart from "no traffic".
 */
export async function summariseFallbacks(db: ApiDatabase, since: Date): Promise<FallbackSummary> {
  const [row] = await db
    .select({
      totalEvents: sql<number>`count(*)::int`,
      successCount: sql<number>`count(*) filter (where ${fallbackEvents.success})::int`,
      failureCount: sql<number>`count(*) filter (where not ${fallbackEvents.success})::int`,
      avgTotalLatencyMs: sql<number>`coalesce(avg(${fallbackEvents.totalLatencyMs}), 0)::double precision`,
      avgAttempts: sql<number>`coalesce(avg(jsonb_array_length(${fallbackEvents.attempts})), 0)::double precision`,
      maxAttempts: sql<number>`coalesce(max(jsonb_array_length(${fallbackEvents.attempts})), 0)::int`,
    })
    .from(fallbackEvents)
    .where(gte(fallbackEvents.timestamp, since));
  return row;
}

export interface FailureReasonCount {
  readonly reason: string;
  readonly count: number;
  readonly avgLatencyMs: number;
}

/** The ten commonest failure reasons across every attempt in the window. */
export async function topFailureReasons(db: ApiDatabase, since: Date): Promise<FailureReasonCount[]> {
  return db.execute<FailureReasonCount & Record<string, unknown>>(sql`
    select
      attempt->>'reason' as "reason",
      count(*)::int as "count",
      round(coalesce(avg((attempt->>'latencyMs')::double precision), 0)::numeric, 0)::int as "avgLatencyMs"
    from ${fallbackEvents}, lateral jsonb_array_elements(${fallbackEvents.attempts}) as attempt
    where ${fallbackEvents.timestamp} >= ${since.toISOString()}::timestamptz
    group by attempt->>'reason'
    order by count(*) desc, attempt->>'reason'
    limit 10
  `);
}

export interface FailedProvider {
  readonly provider: string;
  readonly failureCount: number;
  readonly modelCount: number;
  readonly topReason: string | null;
}

/**
 * The ten providers with the most failed attempts in the window.
 *
 * ## `topReason` is the provider's COMMONEST reason — a behaviour change
 *
 * The Mongo pipeline built `reasons` with `$push` and then took
 * `$arrayElemAt: ['$reasons', 0]`, with no `$sort` anywhere in the pipeline. That
 * is whichever attempt the group happened to accumulate first: arbitrary, and
 * not reproducible between two runs over identical data. Postgres has no way to
 * express "an arbitrary one" and reproducing arbitrariness deliberately is not an
 * option, so this returns the reason that occurs MOST for that provider, which is
 * what a field called `topReason` sitting beside `failureCount` is read as
 * meaning everywhere it is displayed.
 *
 * Ties break on the reason text so the answer is stable across runs rather than
 * merely stable-looking.
 */
export async function mostFailedProviders(db: ApiDatabase, since: Date): Promise<FailedProvider[]> {
  return db.execute<FailedProvider & Record<string, unknown>>(sql`
    with attempts as (
      select
        attempt->>'provider' as provider,
        attempt->>'model' as model,
        attempt->>'reason' as reason
      from ${fallbackEvents}, lateral jsonb_array_elements(${fallbackEvents.attempts}) as attempt
      where ${fallbackEvents.timestamp} >= ${since.toISOString()}::timestamptz
    ),
    -- Counted BEFORE anything is joined to it. Joining the per-attempt rows to a
    -- per-(provider, reason) table multiplies them by that provider's number of
    -- distinct reasons, so the failure count comes back as a plausible multiple
    -- of the truth rather than as an error.
    per_provider as (
      select provider, count(*)::int as failure_count, count(distinct model)::int as model_count
      from attempts
      group by provider
    ),
    top_reason as (
      select distinct on (provider) provider, reason
      from (select provider, reason, count(*) as reason_count from attempts group by provider, reason) counted
      order by provider, reason_count desc, reason
    )
    select
      p.provider as "provider",
      p.failure_count as "failureCount",
      p.model_count as "modelCount",
      t.reason as "topReason"
    from per_provider p
    left join top_reason t on t.provider = p.provider
    order by p.failure_count desc, p.provider
    limit 10
  `);
}

export interface ModelFallbackStats {
  readonly aliasModel: string;
  readonly totalEvents: number;
  readonly failures: number;
  readonly successes: number;
  readonly avgAttempts: number;
  readonly fallbackRate: number;
}

/** Per alias model, the twenty with the most failures. */
export async function failuresByModel(db: ApiDatabase, since: Date): Promise<ModelFallbackStats[]> {
  return db.execute<ModelFallbackStats & Record<string, unknown>>(sql`
    select
      ${fallbackEvents.aliasModel} as "aliasModel",
      count(*)::int as "totalEvents",
      count(*) filter (where not ${fallbackEvents.success})::int as "failures",
      count(*) filter (where ${fallbackEvents.success})::int as "successes",
      round(coalesce(avg(jsonb_array_length(${fallbackEvents.attempts})), 0)::numeric, 1)::double precision as "avgAttempts",
      -- greatest(count(*), 1) mirrors the source's $max of totalEvents and 1.
      -- A group's count cannot be zero, so this is belt and braces rather than a
      -- live division guard. (No backticks in these comments: the whole
      -- statement is a template literal and one would end it.)
      round(
        (count(*) filter (where not ${fallbackEvents.success})::numeric
          / greatest(count(*), 1)) * 100, 1
      )::double precision as "fallbackRate"
    from ${fallbackEvents}
    where ${fallbackEvents.timestamp} >= ${since.toISOString()}::timestamptz
    group by ${fallbackEvents.aliasModel}
    order by count(*) filter (where not ${fallbackEvents.success}) desc, ${fallbackEvents.aliasModel}
    limit 20
  `);
}

/** The twenty most recent failed events in the window. */
export async function recentFailures(db: ApiDatabase, since: Date, limit = 20) {
  return db
    .select()
    .from(fallbackEvents)
    .where(and(gte(fallbackEvents.timestamp, since), eq(fallbackEvents.success, false)))
    .orderBy(desc(fallbackEvents.timestamp))
    .limit(limit);
}
