/**
 * The per-request spend ledger, on Postgres.
 *
 * `lib/cost-tracker.ts` is the only caller: it declared the Mongoose model
 * inline and exported functions rather than the model, so the store moves with
 * no call-site edit anywhere. This file holds the statements; the pricing
 * arithmetic stays in `cost-tracker.ts` because it depends on
 * `getModelPricing()`, which is CODE rather than data and has no SQL form.
 *
 * ## Every aggregate here is cast, and the cast is not cosmetic
 *
 * postgres.js decodes `bigint`/`int8` as a STRING while drizzle types the same
 * expression `number`, so `total + 1` type-checks clean and concatenates. Two of
 * the three aggregate shapes below land on it:
 *
 * - `sum(cost_usd)` is `double precision` in and `double precision` out, which
 *   decodes as a JS number. Safe by the column's type, not by care.
 * - `sum(total_tokens)` is `sum(integer)`, which returns **`bigint`**. Cast to
 *   `double precision`, not to `int`: a per-user token total genuinely can pass
 *   2^31, and `float8` is exact for integers to 2^53.
 * - `count(*)` returns `bigint` too. `::int` is enough for a row count.
 *
 * A test that aggregates ONE row cannot tell a string from a number here — `"5"`
 * and `5` both print as 5 — so the suite asserts `typeof` and sums two rows.
 */

import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { costEntries } from '../schema/usage';
import type { CreditFundingSource } from '../../domain/credit-funding.js';

/** One row as written. `cost-tracker.ts` owns the arithmetic that produced it. */
export interface CostEntryRow {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly routingProfileId: string;
  readonly actualProvider: string;
  readonly actualModelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  /** Which balance the customer's charge came out of. `null` when no reservation backed it. */
  readonly grantKind: CreditFundingSource | null;
  readonly savedFromCache: boolean;
  readonly timestamp: Date;
}

export async function insertCostEntry(db: ApiDatabase, entry: CostEntryRow): Promise<void> {
  await db.insert(costEntries).values({
    userId: entry.userId,
    sessionId: entry.sessionId,
    routingProfileId: entry.routingProfileId,
    actualProvider: entry.actualProvider,
    actualModelId: entry.actualModelId,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    costUsd: entry.costUsd,
    grantKind: entry.grantKind,
    savedFromCache: entry.savedFromCache,
    timestamp: entry.timestamp,
  });
}

/**
 * The window filter, built through the query builder rather than a raw template.
 *
 * A bare `Date` interpolated into `sql` fails in the DRIVER before the statement
 * is sent (`ERR_INVALID_ARG_TYPE`). `gte`/`lte` route the value through the
 * column's own mapper and cannot be got wrong.
 */
function inWindow(startDate?: Date, endDate?: Date): SQL | undefined {
  const bounds: SQL[] = [];
  if (startDate) bounds.push(gte(costEntries.timestamp, startDate));
  if (endDate) bounds.push(lte(costEntries.timestamp, endDate));
  return bounds.length ? and(...bounds) : undefined;
}

/**
 * Every entry in a window, optionally for one user.
 *
 * Rows rather than an aggregate because the caller's cache-savings and
 * free-tier-savings figures re-price each entry through `getModelPricing()`.
 * That is the same whole-collection read Mongo did; the aggregation that CAN be
 * expressed in SQL is expressed in SQL, below.
 */
export async function selectCostEntries(
  db: ApiDatabase,
  filter: { userId?: string; startDate?: Date; endDate?: Date },
): Promise<CostEntryRow[]> {
  const conditions: SQL[] = [];
  if (filter.userId) conditions.push(eq(costEntries.userId, filter.userId));
  const window = inWindow(filter.startDate, filter.endDate);
  if (window) conditions.push(window);

  const rows = await db
    .select({
      userId: costEntries.userId,
      sessionId: costEntries.sessionId,
      routingProfileId: costEntries.routingProfileId,
      actualProvider: costEntries.actualProvider,
      actualModelId: costEntries.actualModelId,
      inputTokens: costEntries.inputTokens,
      outputTokens: costEntries.outputTokens,
      totalTokens: costEntries.totalTokens,
      costUsd: costEntries.costUsd,
      grantKind: costEntries.grantKind,
      savedFromCache: costEntries.savedFromCache,
      timestamp: costEntries.timestamp,
    })
    .from(costEntries)
    .where(conditions.length ? and(...conditions) : undefined);

  return rows;
}

/** How many distinct accounts spent anything in the window. */
export async function countDistinctCostEntryUsers(
  db: ApiDatabase,
  filter: { startDate?: Date; endDate?: Date },
): Promise<number> {
  const [row] = await db
    .select({ users: sql<number>`count(distinct ${costEntries.userId})::int` })
    .from(costEntries)
    .where(inWindow(filter.startDate, filter.endDate));
  return row?.users ?? 0;
}

export interface TopUserByCost {
  readonly userId: string;
  readonly totalSpent: number;
  readonly totalTokens: number;
  readonly totalRequests: number;
}

/** The biggest spenders in a window, most expensive first. */
export async function aggregateTopUsersByCost(
  db: ApiDatabase,
  options: { limit: number; startDate?: Date; endDate?: Date },
): Promise<TopUserByCost[]> {
  const totalSpent = sql<number>`coalesce(sum(${costEntries.costUsd}), 0)`;
  return db
    .select({
      userId: costEntries.userId,
      totalSpent,
      // `sum(integer)` is `bigint` — see the file comment.
      totalTokens: sql<number>`coalesce(sum(${costEntries.totalTokens}), 0)::double precision`,
      totalRequests: sql<number>`count(*)::int`,
    })
    .from(costEntries)
    .where(inWindow(options.startDate, options.endDate))
    .groupBy(costEntries.userId)
    .orderBy(desc(totalSpent))
    .limit(options.limit);
}

export interface ModelEfficiency {
  readonly routingProfileId: string;
  readonly avgCostPer1kTokens: number;
  readonly totalRequests: number;
  readonly totalCost: number;
}

/**
 * Cost per 1000 tokens per Alia-branded model, cheapest first.
 *
 * The `nullif` guard is the source's `$cond: [{$gt: ['$totalTokens', 0]}, …, 0]`:
 * a model whose rows all recorded zero tokens gets 0 rather than a division by
 * zero. `coalesce` turns the resulting NULL back into that 0.
 */
export async function aggregateModelEfficiency(db: ApiDatabase): Promise<ModelEfficiency[]> {
  const avgCostPer1kTokens = sql<number>`coalesce(
    sum(${costEntries.costUsd}) / nullif(sum(${costEntries.totalTokens}), 0) * 1000,
    0
  )`;
  return db
    .select({
      routingProfileId: costEntries.routingProfileId,
      avgCostPer1kTokens,
      totalRequests: sql<number>`count(*)::int`,
      totalCost: sql<number>`coalesce(sum(${costEntries.costUsd}), 0)`,
    })
    .from(costEntries)
    .groupBy(costEntries.routingProfileId)
    .orderBy(avgCostPer1kTokens);
}

/** One account's most recent entries, newest first. */
export async function selectRecentCostEntries(
  db: ApiDatabase,
  userId: string,
  limit: number,
): Promise<CostEntryRow[]> {
  return db
    .select({
      userId: costEntries.userId,
      sessionId: costEntries.sessionId,
      routingProfileId: costEntries.routingProfileId,
      actualProvider: costEntries.actualProvider,
      actualModelId: costEntries.actualModelId,
      inputTokens: costEntries.inputTokens,
      outputTokens: costEntries.outputTokens,
      totalTokens: costEntries.totalTokens,
      costUsd: costEntries.costUsd,
      grantKind: costEntries.grantKind,
      savedFromCache: costEntries.savedFromCache,
      timestamp: costEntries.timestamp,
    })
    .from(costEntries)
    .where(eq(costEntries.userId, userId))
    .orderBy(desc(costEntries.timestamp))
    .limit(limit);
}
