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

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { chatAnalytics } from '../schema/usage';

export interface ChatAnalyticsRecord {
  readonly oxyUserId: string;
  readonly conversationId?: string;
  readonly model: string;
  readonly aliaModelId?: string;
  readonly provider: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly platform: string;
  readonly skillId?: string;
}

export async function insertChatAnalytics(
  db: ApiDatabase,
  record: ChatAnalyticsRecord,
): Promise<void> {
  await db.insert(chatAnalytics).values({
    oxyUserId: record.oxyUserId,
    conversationId: record.conversationId ?? null,
    model: record.model,
    aliaModelId: record.aliaModelId ?? null,
    provider: record.provider,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens: record.totalTokens,
    latencyMs: record.latencyMs,
    platform: record.platform,
    skillId: record.skillId ?? null,
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
  readonly _id: string;
  readonly count: number;
  readonly totalTokens: number;
  readonly avgLatency: number;
}

/**
 * One row per model, busiest first.
 *
 * Grouped by `coalesce(alia_model_id, model)`, which is the source's
 * `$ifNull: ['$aliaModelId', '$model']`. The caller resolves each key through
 * `getAliaModel()`, which is keyed by the ALIAS — so grouping by `model` alone
 * would resolve nothing and the route would return an empty list.
 */
export async function aggregateUsageByModel(
  db: ApiDatabase,
  oxyUserId: string,
  since: Date,
): Promise<UsageByModel[]> {
  const modelKey = sql<string>`coalesce(${chatAnalytics.aliaModelId}, ${chatAnalytics.model})`;
  return db
    .select({ _id: modelKey, count: rowCount, totalTokens: sumTokens, avgLatency })
    .from(chatAnalytics)
    .where(ownedSince(oxyUserId, since))
    .groupBy(modelKey)
    .orderBy(desc(rowCount));
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
