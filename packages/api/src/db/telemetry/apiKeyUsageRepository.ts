/**
 * Developer API request records, on Postgres.
 *
 * One row per request served through Alia's public API. Three unrelated things
 * read it — rate limiting, the developer dashboard's analytics, and credit
 * anomaly detection — and they are grouped here because they are one table, not
 * because they are one concern.
 *
 * Swept at 90 days by `db/expiryTargets.ts`, from `timestamp`: this table has no
 * `created_at` (the Mongoose schema set `timestamps: false`) so the event time is
 * its only clock. The retention is the longest in the schema on purpose — the
 * billing and rate-limit reads work in monthly windows.
 *
 * ## Day buckets are UTC, explicitly
 *
 * Mongo's `$dateToString` with no `timezone` is UTC. `to_char()` over a
 * `timestamptz` uses the SESSION time zone, so the same code silently produces
 * different day boundaries depending on what the connection happens to be set
 * to — a whole day of usage moving between buckets, with no error and a
 * perfectly ordinary-looking chart. Every bucket below therefore says
 * `at time zone 'UTC'`, and a test pins a row placed just inside a UTC day.
 *
 * ## Every aggregate is cast at the boundary
 *
 * `count(*)` is bigint and `sum(integer)` is bigint; postgres.js decodes both as
 * STRINGS while drizzle types them `number`. A rate limiter comparing `"1500"`
 * to a numeric ceiling compares lexicographically and lets traffic through.
 */

import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../index';
import { apiKeyUsage } from '../schema/telemetry';
import type { ApiKeyUsageAuthType, ApiKeyUsageMethod } from '../../domain/api-key-usage.js';

export interface NewApiKeyUsage {
  readonly apiKeyId?: string | null;
  readonly oxyUserId: string;
  readonly appId?: string | null;
  readonly authType: ApiKeyUsageAuthType;
  readonly serviceApp?: string | null;
  readonly endpoint: string;
  readonly method: ApiKeyUsageMethod;
  readonly statusCode: number;
  readonly tokensUsed?: number;
  readonly creditsUsed?: number;
  readonly responseTimeMs?: number | null;
  readonly userAgent?: string | null;
  readonly timestamp?: Date;
}

/** Append one request record. */
export async function recordApiKeyUsage(db: Executor, usage: NewApiKeyUsage): Promise<void> {
  await db.insert(apiKeyUsage).values({
    apiKeyId: usage.apiKeyId ?? null,
    oxyUserId: usage.oxyUserId,
    appId: usage.appId ?? null,
    authType: usage.authType,
    serviceApp: usage.serviceApp ?? null,
    endpoint: usage.endpoint,
    method: usage.method,
    statusCode: usage.statusCode,
    tokensUsed: usage.tokensUsed ?? 0,
    creditsUsed: usage.creditsUsed ?? 0,
    responseTimeMs: usage.responseTimeMs ?? null,
    userAgent: usage.userAgent ?? null,
    timestamp: usage.timestamp ?? new Date(),
  });
}

/**
 * Which rows an analytics read covers.
 *
 * A union rather than an optional-field bag, so "every app this developer owns"
 * and "the whole platform" cannot be confused by forgetting to pass a filter:
 * the unscoped read has to be asked for by name.
 */
export type UsageScope =
  | { readonly kind: 'apps'; readonly appIds: string[] }
  | { readonly kind: 'key'; readonly apiKeyId: string }
  | { readonly kind: 'platform' };

function scopeCondition(scope: UsageScope): SQL | undefined {
  switch (scope.kind) {
    case 'apps':
      // An empty list matches nothing, which is what Mongo's `$in: []` did. Said
      // explicitly because `inArray(col, [])` is a shape drizzle has changed its
      // handling of, and "matches everything" would leak one developer's app
      // analytics to another.
      return scope.appIds.length === 0
        ? sql`false`
        : inArray(apiKeyUsage.appId, scope.appIds);
    case 'key':
      return eq(apiKeyUsage.apiKeyId, scope.apiKeyId);
    case 'platform':
      return undefined;
  }
}

function windowed(scope: UsageScope, since: Date): SQL | undefined {
  return and(scopeCondition(scope), gte(apiKeyUsage.timestamp, since));
}

export interface UsageSummary {
  readonly totalRequests: number;
  readonly totalTokens: number;
  readonly totalCredits: number;
  readonly avgResponseTime: number;
  readonly successfulRequests: number;
  readonly errorRequests: number;
}

/**
 * The dashboard summary.
 *
 * Always one row — an aggregate with no `GROUP BY` returns zeros over an empty
 * set, where Mongo returned no document and each of the five call sites
 * substituted its own zeroed object.
 *
 * `avgResponseTime` is coalesced to 0. In Mongo it came back NULL when rows
 * existed but none carried a timing, and 0 when there were no rows at all — the
 * same field meaning "no data" two different ways depending on which emptiness
 * you hit. It is 0 for both now, which is the value every call site already
 * substituted for the case it handled.
 */
export async function usageSummary(
  db: Executor,
  scope: UsageScope,
  since: Date,
): Promise<UsageSummary> {
  const [row] = await db
    .select({
      totalRequests: sql<number>`count(*)::int`,
      totalTokens: sql<number>`coalesce(sum(${apiKeyUsage.tokensUsed}), 0)::int`,
      totalCredits: sql<number>`coalesce(sum(${apiKeyUsage.creditsUsed}), 0)::int`,
      avgResponseTime: sql<number>`coalesce(avg(${apiKeyUsage.responseTimeMs}), 0)::double precision`,
      successfulRequests: sql<number>`count(*) filter (where ${apiKeyUsage.statusCode} < 400)::int`,
      errorRequests: sql<number>`count(*) filter (where ${apiKeyUsage.statusCode} >= 400)::int`,
    })
    .from(apiKeyUsage)
    .where(windowed(scope, since));
  return row;
}

export interface UsageDay {
  readonly _id: string;
  readonly requests: number;
  readonly tokens: number;
  readonly credits: number;
}

/** Per UTC day, oldest first — the chart series. `_id` is the wire key. */
export async function usageByDay(
  db: Executor,
  scope: UsageScope,
  since: Date,
): Promise<UsageDay[]> {
  const day = sql<string>`to_char(${apiKeyUsage.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`;
  return db
    .select({
      _id: day,
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${apiKeyUsage.tokensUsed}), 0)::int`,
      credits: sql<number>`coalesce(sum(${apiKeyUsage.creditsUsed}), 0)::int`,
    })
    .from(apiKeyUsage)
    .where(windowed(scope, since))
    .groupBy(day)
    .orderBy(day);
}

export interface UsageEndpoint {
  readonly _id: string;
  readonly requests: number;
  readonly tokens: number;
}

/** The busiest endpoints. `_id` is the wire key. */
export async function usageByEndpoint(
  db: Executor,
  scope: UsageScope,
  since: Date,
  limit = 10,
): Promise<UsageEndpoint[]> {
  return db
    .select({
      _id: apiKeyUsage.endpoint,
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${apiKeyUsage.tokensUsed}), 0)::int`,
    })
    .from(apiKeyUsage)
    .where(windowed(scope, since))
    .groupBy(apiKeyUsage.endpoint)
    // Ties break on the endpoint so a page of ten is stable between calls.
    .orderBy(sql`count(*) desc`, apiKeyUsage.endpoint)
    .limit(limit);
}

// ============== RATE LIMITING ==============

export interface UsageWindow {
  readonly requests: number;
  readonly tokens: number;
}

/**
 * Requests and tokens in one window, for one key or one session user.
 *
 * The source ran four queries per check — a `countDocuments` and an `aggregate`
 * per window. Counting and summing in the same statement is exactly equivalent
 * and halves the round trips on a path that runs on EVERY request.
 */
export async function usageWindow(
  db: Executor,
  subject: { apiKeyId: string } | { oxyUserId: string; authType: ApiKeyUsageAuthType },
  since: Date,
): Promise<UsageWindow> {
  const who =
    'apiKeyId' in subject
      ? eq(apiKeyUsage.apiKeyId, subject.apiKeyId)
      : and(eq(apiKeyUsage.oxyUserId, subject.oxyUserId), eq(apiKeyUsage.authType, subject.authType));

  const [row] = await db
    .select({
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${apiKeyUsage.tokensUsed}), 0)::int`,
    })
    .from(apiKeyUsage)
    .where(and(who, gte(apiKeyUsage.timestamp, since)));
  return row;
}

// ============== CREDIT SPEND ==============

/**
 * Credits a request consumed.
 *
 * `credits_used` when it was recorded, otherwise a token-derived estimate of one
 * credit per started thousand tokens, floored at 1. Both call sites computed
 * this identically and both filtered to rows where one of the two is positive,
 * so the expression and its filter live together here — separating them is how
 * a row with neither ends up contributing a phantom credit.
 */
const effectiveCredits = sql`
  case when ${apiKeyUsage.creditsUsed} > 0
    then ${apiKeyUsage.creditsUsed}
    else greatest(ceil(${apiKeyUsage.tokensUsed}::numeric / 1000), 1)
  end`;

const spentSomething = sql`(${apiKeyUsage.creditsUsed} > 0 or ${apiKeyUsage.tokensUsed} > 0)`;

export interface CreditDay {
  readonly _id: string;
  readonly used: number;
}

/** Credits spent per UTC day by one user, optionally bounded above. */
export async function creditSpendByDay(
  db: Executor,
  oxyUserId: string,
  since: Date,
  until?: Date,
): Promise<CreditDay[]> {
  const day = sql<string>`to_char(${apiKeyUsage.timestamp} at time zone 'UTC', 'YYYY-MM-DD')`;
  return db
    .select({
      _id: day,
      used: sql<number>`coalesce(sum(${effectiveCredits}), 0)::int`,
    })
    .from(apiKeyUsage)
    .where(
      and(
        eq(apiKeyUsage.oxyUserId, oxyUserId),
        gte(apiKeyUsage.timestamp, since),
        until ? lt(apiKeyUsage.timestamp, until) : undefined,
        spentSomething,
      ),
    )
    .groupBy(day)
    .orderBy(day);
}

/** Total credits one user has spent since an instant. */
export async function creditSpendTotal(
  db: Executor,
  oxyUserId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ used: sql<number>`coalesce(sum(${effectiveCredits}), 0)::int` })
    .from(apiKeyUsage)
    .where(
      and(eq(apiKeyUsage.oxyUserId, oxyUserId), gte(apiKeyUsage.timestamp, since), spentSomething),
    );
  return row.used;
}

// ============== DELETION ==============

/**
 * Drop the usage history for one app, or one key.
 *
 * Both are scoped by `oxyUserId` as well as by the id, exactly as the source
 * was: the id alone would let a developer delete another developer's records by
 * guessing one, and the owner check is the only thing standing in the way.
 *
 * The count is Postgres's row count, which is `matchedCount`. A DELETE has no
 * `modifiedCount` distinction to lose, so the substitution is exact here rather
 * than merely safe.
 */
export async function deleteUsageForApp(
  db: Executor,
  appId: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(apiKeyUsage)
    .where(and(eq(apiKeyUsage.appId, appId), eq(apiKeyUsage.oxyUserId, oxyUserId)));
  return result.count;
}

export async function deleteUsageForKey(
  db: Executor,
  apiKeyId: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(apiKeyUsage)
    .where(and(eq(apiKeyUsage.apiKeyId, apiKeyId), eq(apiKeyUsage.oxyUserId, oxyUserId)));
  return result.count;
}
