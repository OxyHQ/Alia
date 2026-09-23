/**
 * Developer API request records, on Postgres.
 *
 * One row per request served through Alia's public API. Two unrelated things
 * read it — rate limiting and credit spend (the usage chart and anomaly
 * detection) — and they are grouped here because they are one table, not
 * because they are one concern. The developer-dashboard analytics that read it
 * by app and by key left with the retired `alia_sk_*` keys; the historical
 * `api_key_id` / `app_id` values stay on old rows.
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

import { and, eq, gte, lt, sql } from 'drizzle-orm';
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

// ============== RATE LIMITING ==============

export interface UsageWindow {
  readonly requests: number;
  readonly tokens: number;
}

/**
 * Requests and tokens in one window, for one user under one auth type.
 *
 * The source ran four queries per check — a `countDocuments` and an `aggregate`
 * per window. Counting and summing in the same statement is exactly equivalent
 * and halves the round trips on a path that runs on EVERY request.
 */
export async function usageWindow(
  db: Executor,
  subject: { oxyUserId: string; authType: ApiKeyUsageAuthType },
  since: Date,
): Promise<UsageWindow> {
  const who = and(eq(apiKeyUsage.oxyUserId, subject.oxyUserId), eq(apiKeyUsage.authType, subject.authType));

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
