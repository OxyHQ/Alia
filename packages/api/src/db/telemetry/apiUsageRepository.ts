/**
 * Provider-key token accounting, on Postgres.
 *
 * How many tokens one of Alia's OWN upstream credentials spent. Not to be
 * confused with `api_key_usage`, which records what a DEVELOPER spent with
 * Alia — the names are one character apart and they share no column meaning
 * beyond a timestamp.
 *
 * Swept at 48 hours by `db/expiryTargets.ts`. `key_id` names a `provider_keys`
 * row and carries no foreign key deliberately; the sweep bounds how long it can
 * dangle.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Executor } from '../index';
import { apiUsage } from '../schema/telemetry';

export interface NewApiUsage {
  readonly keyId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly tokens: number;
  readonly timestamp?: Date;
}

/** Append one usage record. */
export async function recordApiUsage(db: Executor, entry: NewApiUsage): Promise<void> {
  await db.insert(apiUsage).values({
    keyId: entry.keyId,
    provider: entry.provider,
    modelId: entry.modelId,
    tokens: entry.tokens,
    timestamp: entry.timestamp ?? new Date(),
  });
}

export interface UsageCounts {
  readonly count: number;
  readonly tokens: number;
}

export interface KeyUsageWindows {
  readonly second: UsageCounts;
  readonly minute: UsageCounts;
  readonly hour: UsageCounts;
  readonly day: UsageCounts;
}

/**
 * All four rate-limit windows for one key, in ONE statement.
 *
 * The Mongo version built a `$facet` whose branches were added only for the
 * limits a key actually configured. Postgres has no facet operator, and the
 * equivalent — aggregate `FILTER` clauses over a single day-bounded scan — is
 * both simpler and unconditional, so the "only compute what is configured"
 * optimisation disappears. That is deliberate: the four filters run over rows
 * already fetched for the day window, and the branchless version cannot get the
 * *wrong* window for a limit, which the conditional one could.
 *
 * Every aggregate is cast. `count(*)` and `sum(integer)` are bigint and arrive
 * as STRINGS; a limiter comparing `"1500"` against a numeric ceiling compares
 * lexicographically and lets traffic through.
 */
export async function keyUsageWindows(
  db: Executor,
  keyId: string,
  now: Date,
): Promise<KeyUsageWindows> {
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const [row] = await db
    .select({
      secondCount: sql<number>`count(*) filter (where ${apiUsage.timestamp} >= ${at(1000)}::timestamptz)::int`,
      secondTokens: sql<number>`coalesce(sum(${apiUsage.tokens}) filter (where ${apiUsage.timestamp} >= ${at(1000)}::timestamptz), 0)::int`,
      minuteCount: sql<number>`count(*) filter (where ${apiUsage.timestamp} >= ${at(60_000)}::timestamptz)::int`,
      minuteTokens: sql<number>`coalesce(sum(${apiUsage.tokens}) filter (where ${apiUsage.timestamp} >= ${at(60_000)}::timestamptz), 0)::int`,
      hourCount: sql<number>`count(*) filter (where ${apiUsage.timestamp} >= ${at(3_600_000)}::timestamptz)::int`,
      hourTokens: sql<number>`coalesce(sum(${apiUsage.tokens}) filter (where ${apiUsage.timestamp} >= ${at(3_600_000)}::timestamptz), 0)::int`,
      dayCount: sql<number>`count(*)::int`,
      dayTokens: sql<number>`coalesce(sum(${apiUsage.tokens}), 0)::int`,
    })
    .from(apiUsage)
    .where(
      and(
        eq(apiUsage.keyId, keyId),
        // The outer bound. The day figures need no FILTER because this IS the
        // day window — exactly as the source's un-matched `dayStats` branch
        // inherited the pipeline's own `$match`.
        gte(apiUsage.timestamp, new Date(now.getTime() - 86_400_000)),
      ),
    );

  return {
    second: { count: row.secondCount, tokens: row.secondTokens },
    minute: { count: row.minuteCount, tokens: row.minuteTokens },
    hour: { count: row.hourCount, tokens: row.hourTokens },
    day: { count: row.dayCount, tokens: row.dayTokens },
  };
}
