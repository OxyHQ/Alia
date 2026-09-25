/**
 * Per-completion usage records, on Postgres.
 *
 * Written by `lib/hooks/built-in/analytics-hook.ts` after every chat; read by
 * the three `GET /analytics/*` routes, each of which was a `$group` pipeline and
 * is now a `GROUP BY`.
 *
 * ## The wire shape keeps `_id`
 *
 * Mongo's `$group` names its key `_id`, and the routes hand the aggregate
 * documents to the client untouched, so `_id` is a published field of these
 * responses and not an artifact of the driver. Renaming it here would be a
 * breaking API change disguised as a cleanup, and `packages/app` reads it.
 *
 * ## Three casts, one timezone, and none of them is optional
 *
 * - `count(*)` and `sum(total_tokens)` return `bigint`, which postgres.js
 *   decodes as a STRING while drizzle types it `number`.
 * - **`avg(latency_ms)` returns `numeric`**, which decodes as a string too. This
 *   is the one that does not look like the others: `avg` over an `integer` is
 *   not an integer type, so the usual "it is a sum, cast it" instinct misses it.
 * - `to_char(created_at, …)` formats in the SESSION's timezone, while Mongo's
 *   `$dateToString` with no `timezone` is UTC. Without `at time zone 'UTC'` the
 *   day buckets silently shift for any server not running on UTC, which is a
 *   wrong answer that looks like a plausible one.
 */

import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { chatAnalytics } from '../schema/usage';

export interface ChatAnalyticsRecord {
  readonly oxyUserId: string;
  readonly conversationId?: string;
  /** What the caller asked for, verbatim. Required, so a row cannot fail to say. */
  readonly requestedModelId: string;
  /** The reasoning parameter, kept out of the model identifier. */
  readonly reasoningEffort: string | null;
  /** The `publisher/model` (or `local/...`) the turn ran on. */
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  /** Null where a turn produced no first token, never zero. */
  readonly timeToFirstTokenMs: number | null;
  /** The `AliaErrorCode` the turn ended with, or null when it succeeded. */
  readonly errorClass: string | null;
  readonly cancelled: boolean;
  /** The revision-pinned reference Kaana served, or null when no answer named one. */
  readonly resolvedModelReference: string | null;
  readonly platform: string;
  /** Every skill that reached the model this turn. Empty for a turn that activated none. */
  readonly skillNames?: string[];
}

export async function insertChatAnalytics(
  db: ApiDatabase,
  record: ChatAnalyticsRecord,
): Promise<void> {
  await db.insert(chatAnalytics).values({
    oxyUserId: record.oxyUserId,
    conversationId: record.conversationId ?? null,
    requestedModelId: record.requestedModelId,
    reasoningEffort: record.reasoningEffort,
    model: record.model,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens: record.totalTokens,
    latencyMs: record.latencyMs,
    timeToFirstTokenMs: record.timeToFirstTokenMs,
    errorClass: record.errorClass,
    cancelled: record.cancelled,
    resolvedModelReference: record.resolvedModelReference,
    platform: record.platform,
    skillNames: record.skillNames ?? [],
  });
}

/** The UTC calendar day a row falls on — Mongo's `$dateToString` default. */
const utcDay = sql<string>`to_char(${chatAnalytics.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
/** `avg` over an `integer` column is `numeric`, which decodes as a string. */
const avgLatency = sql<number>`coalesce(avg(${chatAnalytics.latencyMs}), 0)::double precision`;
const sumTokens = sql<number>`coalesce(sum(${chatAnalytics.totalTokens}), 0)::double precision`;
const rowCount = sql<number>`count(*)::int`;

function ownedSince(oxyUserId: string, since: Date) {
  // `gte` rather than a raw template: a bare `Date` interpolated into `sql`
  // fails in the DRIVER before the statement is sent.
  return and(eq(chatAnalytics.oxyUserId, oxyUserId), gte(chatAnalytics.createdAt, since));
}

export interface UsageByDay {
  readonly _id: string;
  readonly conversations: number;
  readonly totalTokens: number;
  readonly avgLatency: number;
}

/** One row per UTC day, oldest first. */
export async function aggregateUsageByDay(
  db: ApiDatabase,
  oxyUserId: string,
  since: Date,
): Promise<UsageByDay[]> {
  return db
    .select({ _id: utcDay, conversations: rowCount, totalTokens: sumTokens, avgLatency })
    .from(chatAnalytics)
    .where(ownedSince(oxyUserId, since))
    .groupBy(utcDay)
    .orderBy(utcDay);
}

export interface UsageByModel {
  /**
   * The model the group is named by. `null` is reachable — rows from before
   * `model` was written group under NULL — and the route drops it.
   */
  readonly _id: string | null;
  readonly count: number;
  readonly totalTokens: number;
  readonly avgLatency: number;
}

/**
 * One row per model a person ran, busiest first.
 *
 * Grouped by `model`, the `publisher/model` the turn ran on. The route names
 * each group from the live catalogue and drops what the catalogue no longer
 * offers (including pre-0078 rows holding a routing alias).
 */
export async function aggregateUsageByModel(
  db: ApiDatabase,
  oxyUserId: string,
  since: Date,
): Promise<UsageByModel[]> {
  return db
    .select({
      _id: chatAnalytics.model,
      count: rowCount,
      totalTokens: sumTokens,
      avgLatency,
    })
    .from(chatAnalytics)
    .where(ownedSince(oxyUserId, since))
    .groupBy(chatAnalytics.model)
    .orderBy(desc(rowCount));
}

/**
 * Successful turns per model across ALL of Alia since `since` — the usage
 * signal that ranks featured models and picks a new person's default
 * (`lib/models/selection.ts`). Failed turns are not usage.
 */
export async function aggregateModelTurnsSince(
  db: ApiDatabase,
  since: Date,
): Promise<{ modelId: string; turns: number }[]> {
  const rows = await db
    .select({ modelId: chatAnalytics.model, turns: rowCount })
    .from(chatAnalytics)
    .where(and(gte(chatAnalytics.createdAt, since), isNotNull(chatAnalytics.model), isNull(chatAnalytics.errorClass)))
    .groupBy(chatAnalytics.model);
  return rows.flatMap((row) => (row.modelId === null ? [] : [{ modelId: row.modelId, turns: Number(row.turns) }]));
}

/** The model of a person's most recent successful turn, or `null`. */
export async function findLastUsedModel(db: ApiDatabase, oxyUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ model: chatAnalytics.model })
    .from(chatAnalytics)
    .where(and(eq(chatAnalytics.oxyUserId, oxyUserId), isNotNull(chatAnalytics.model), isNull(chatAnalytics.errorClass)))
    .orderBy(desc(chatAnalytics.createdAt))
    .limit(1);
  return row?.model ?? null;
}

export interface CreditsByDay {
  readonly _id: string;
  readonly totalTokens: number;
  readonly conversations: number;
}

/** One row per UTC day, oldest first. Tokens only — no latency. */
export async function aggregateCreditsByDay(
  db: ApiDatabase,
  oxyUserId: string,
  since: Date,
): Promise<CreditsByDay[]> {
  return db
    .select({ _id: utcDay, totalTokens: sumTokens, conversations: rowCount })
    .from(chatAnalytics)
    .where(ownedSince(oxyUserId, since))
    .groupBy(utcDay)
    .orderBy(utcDay);
}
