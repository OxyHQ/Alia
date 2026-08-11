import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  creditSpendByDay,
  creditSpendTotal,
  deleteUsageForApp,
  deleteUsageForKey,
  recordApiKeyUsage,
  usageByDay,
  usageByEndpoint,
  usageSummary,
  usageWindow,
  type NewApiKeyUsage,
  type UsageScope,
} from '../telemetry/apiKeyUsageRepository';
import { apiKeyUsage } from '../schema/telemetry';

/**
 * `api_key_usage`, against a real server.
 *
 * This one table backs rate limiting, developer analytics and credit anomaly
 * detection, and each of the three fails PLAUSIBLY: a limiter comparing
 * `"1500"` to a ceiling lets traffic through, a day bucket in the wrong time
 * zone moves usage between columns of a chart, and an empty scope that matches
 * everything shows one developer another's numbers.
 *
 * Ids are namespaced per test and every read is windowed, because the pgdb suite
 * shares one database and the platform-scoped reads see every row in the table.
 * Instants are relative to `now` — this is a 90-day expiry target.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const MINUTE = 60 * 1000;
const minutesAgo = (n: number) => new Date(Date.now() - n * MINUTE);

const usage = (over: Partial<NewApiKeyUsage> = {}): NewApiKeyUsage => ({
  oxyUserId: 'aku-user',
  authType: 'api_key',
  endpoint: '/v1/chat',
  method: 'POST',
  statusCode: 200,
  tokensUsed: 100,
  creditsUsed: 0,
  responseTimeMs: 50,
  timestamp: minutesAgo(1),
  ...over,
});

describe('the summary', () => {
  it('splits successes from errors on the 400 boundary', async () => {
    const appId = 'aku-app-status';
    const scope: UsageScope = { kind: 'apps', appIds: [appId] };
    await recordApiKeyUsage(db, usage({ appId, statusCode: 200 }));
    await recordApiKeyUsage(db, usage({ appId, statusCode: 399 }));
    await recordApiKeyUsage(db, usage({ appId, statusCode: 400 }));
    await recordApiKeyUsage(db, usage({ appId, statusCode: 500 }));

    const summary = await usageSummary(db, scope, minutesAgo(30));
    expect(summary.totalRequests).toBe(4);
    // 399 counts as success and 400 as error — the boundary is `< 400`, and an
    // off-by-one would still produce a plausible 3/1 or 1/3 split.
    expect(summary.successfulRequests).toBe(2);
    expect(summary.errorRequests).toBe(2);
  });

  it('sums tokens and credits as NUMBERS', async () => {
    const appId = 'aku-app-numeric';
    const scope: UsageScope = { kind: 'apps', appIds: [appId] };
    // Two rows, so the numeric and string readings differ: 100 + 100 is 200 as
    // a number and "100100" as text. One row cannot tell them apart.
    await recordApiKeyUsage(db, usage({ appId, tokensUsed: 100, creditsUsed: 3 }));
    await recordApiKeyUsage(db, usage({ appId, tokensUsed: 100, creditsUsed: 4 }));

    const summary = await usageSummary(db, scope, minutesAgo(30));
    expect(summary.totalTokens).toBe(200);
    expect(summary.totalCredits).toBe(7);
    expect(typeof summary.totalTokens).toBe('number');
    expect(typeof summary.totalRequests).toBe('number');
    expect(summary.avgResponseTime).toBe(50);
  });

  it('returns zeros for an empty window rather than nothing', async () => {
    const summary = await usageSummary(db, { kind: 'apps', appIds: ['aku-nobody'] }, minutesAgo(30));
    expect(summary.totalRequests).toBe(0);
    expect(summary.totalTokens).toBe(0);
    // Mongo returned NULL here when rows existed with no timings and 0 when
    // there were no rows; it is 0 for both now.
    expect(summary.avgResponseTime).toBe(0);
  });
});

describe('scoping', () => {
  it('an EMPTY app list matches nothing, not everything', async () => {
    const appId = 'aku-app-scope';
    await recordApiKeyUsage(db, usage({ appId }));

    // The row exists and a populated scope finds it...
    const found = await usageSummary(db, { kind: 'apps', appIds: [appId] }, minutesAgo(30));
    expect(found.totalRequests).toBe(1);

    /**
     * ...and an empty list finds nothing. This is the assertion that matters:
     * a developer with no apps must see zero, not the whole platform's traffic.
     * `inArray(col, [])` is a shape drizzle has changed its handling of, and the
     * permissive reading is a cross-tenant leak that no error would announce.
     */
    const empty = await usageSummary(db, { kind: 'apps', appIds: [] }, minutesAgo(30));
    expect(empty.totalRequests).toBe(0);

    // ...while the platform scope really does see everything, so the zero above
    // is filtering rather than an empty table.
    const platform = await usageSummary(db, { kind: 'platform' }, minutesAgo(30));
    expect(platform.totalRequests).toBeGreaterThan(0);
  });

  it('scopes by key without picking up the same app\'s other keys', async () => {
    const appId = 'aku-app-keys';
    await recordApiKeyUsage(db, usage({ appId, apiKeyId: 'aku-key-a' }));
    await recordApiKeyUsage(db, usage({ appId, apiKeyId: 'aku-key-a' }));
    await recordApiKeyUsage(db, usage({ appId, apiKeyId: 'aku-key-b' }));

    expect((await usageSummary(db, { kind: 'key', apiKeyId: 'aku-key-a' }, minutesAgo(30))).totalRequests).toBe(2);
    // The positive control for the filter.
    expect((await usageSummary(db, { kind: 'key', apiKeyId: 'aku-key-b' }, minutesAgo(30))).totalRequests).toBe(1);
  });
});

describe('day buckets', () => {
  it('buckets by UTC, not by the session time zone', async () => {
    const appId = 'aku-app-utc';
    const scope: UsageScope = { kind: 'apps', appIds: [appId] };

    /**
     * The trap. Mongo's `$dateToString` with no `timezone` is UTC; `to_char()`
     * over a `timestamptz` uses the SESSION time zone. An instant just after
     * midnight UTC lands on one day in UTC and on the PREVIOUS day anywhere west
     * of it — a whole day of usage sliding between buckets, no error, an
     * ordinary-looking chart.
     *
     * Built relative to now: take the most recent midnight UTC that is safely in
     * the past, and put a row one minute after it.
     */
    const now = new Date();
    const midnightUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    // If it is currently within an hour of midnight UTC, step back a day so the
    // fixture is unambiguously in the past.
    const anchor = now.getTime() - midnightUtc < 60 * MINUTE
      ? midnightUtc - 24 * 60 * MINUTE
      : midnightUtc;
    const justAfterMidnight = new Date(anchor + MINUTE);
    const expectedDay = justAfterMidnight.toISOString().slice(0, 10);

    await recordApiKeyUsage(db, usage({ appId, timestamp: justAfterMidnight }));

    /**
     * Run it under a HOSTILE session time zone.
     *
     * This container's `TimeZone` is UTC, so asserting against the default
     * proves nothing — measured: removing `at time zone 'UTC'` from the
     * repository left this test green. `Pacific/Niue` is UTC-11, so an instant
     * one minute past midnight UTC falls on the PREVIOUS day there, and the two
     * readings finally disagree.
     *
     * `SET LOCAL` inside a transaction is what makes this safe: it applies to
     * the one connection drizzle binds the transaction to, and reverts on
     * commit, so a pooled connection cannot carry it into another test file.
     */
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'Pacific/Niue'`);

      // The control: under this session the naive reading really is a different
      // day, so the assertion below has something to distinguish.
      const [naive] = await tx.execute<{ day: string }>(
        sql`select to_char(${apiKeyUsage.timestamp}, 'YYYY-MM-DD') as day
            from ${apiKeyUsage} where ${apiKeyUsage.appId} = ${appId}`,
      );
      expect(naive.day).not.toBe(expectedDay);

      const days = await usageByDay(tx, scope, new Date(anchor - 24 * 60 * MINUTE));
      expect(days).toHaveLength(1);
      expect(days[0]._id).toBe(expectedDay);
      expect(days[0].requests).toBe(1);
    });
  });

  it('orders days oldest-first and keys them as _id', async () => {
    const appId = 'aku-app-order';
    const scope: UsageScope = { kind: 'apps', appIds: [appId] };
    const day = 24 * 60 * MINUTE;
    await recordApiKeyUsage(db, usage({ appId, timestamp: new Date(Date.now() - 2 * day) }));
    await recordApiKeyUsage(db, usage({ appId, timestamp: new Date(Date.now() - 1 * day) }));

    const days = await usageByDay(db, scope, new Date(Date.now() - 5 * day));
    expect(days).toHaveLength(2);
    expect(days[0]._id < days[1]._id).toBe(true);
    // `_id`, not `date` — the client destructures the Mongo `$group` key name.
    expect(days[0]).toHaveProperty('_id');
    expect(typeof days[0].requests).toBe('number');
  });
});

describe('endpoints', () => {
  it('ranks by request count and honours the limit', async () => {
    const appId = 'aku-app-endpoints';
    const scope: UsageScope = { kind: 'apps', appIds: [appId] };
    await recordApiKeyUsage(db, usage({ appId, endpoint: '/quiet', tokensUsed: 5 }));
    for (let i = 0; i < 3; i += 1) {
      await recordApiKeyUsage(db, usage({ appId, endpoint: '/busy', tokensUsed: 10 }));
    }

    const all = await usageByEndpoint(db, scope, minutesAgo(30));
    expect(all[0]._id).toBe('/busy');
    expect(all[0].requests).toBe(3);
    expect(all[0].tokens).toBe(30);
    expect(all[1]._id).toBe('/quiet');

    const capped = await usageByEndpoint(db, scope, minutesAgo(30), 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]._id).toBe('/busy');
  });
});

describe('the rate-limit window', () => {
  it('counts and sums the same window in one answer', async () => {
    const apiKeyId = 'aku-rl-key';
    await recordApiKeyUsage(db, usage({ apiKeyId, tokensUsed: 700, timestamp: minutesAgo(0) }));
    await recordApiKeyUsage(db, usage({ apiKeyId, tokensUsed: 800, timestamp: minutesAgo(0) }));
    // Outside the one-minute window, inside the day.
    await recordApiKeyUsage(db, usage({ apiKeyId, tokensUsed: 5000, timestamp: minutesAgo(30) }));

    const minute = await usageWindow(db, { apiKeyId }, new Date(Date.now() - MINUTE));
    expect(minute.requests).toBe(2);
    expect(minute.tokens).toBe(1500);
    /**
     * The limiter compares this against a numeric ceiling. As a string, "1500"
     * is LESS than "500" lexicographically, so a missing cast does not merely
     * look odd — it silently raises the limit.
     */
    expect(typeof minute.tokens).toBe('number');

    const day = await usageWindow(db, { apiKeyId }, new Date(Date.now() - 24 * 60 * MINUTE));
    expect(day.requests).toBe(3);
    expect(day.tokens).toBe(6500);
  });

  it('separates a session user\'s budget from their API-key traffic', async () => {
    const oxyUserId = 'aku-rl-user';
    await recordApiKeyUsage(db, usage({ oxyUserId, authType: 'session', tokensUsed: 10 }));
    await recordApiKeyUsage(db, usage({ oxyUserId, authType: 'api_key', tokensUsed: 999 }));
    await recordApiKeyUsage(db, usage({ oxyUserId, authType: 'internal', tokensUsed: 999 }));

    const session = await usageWindow(db, { oxyUserId, authType: 'session' }, minutesAgo(30));
    // Only the session row. Dropping the `authType` predicate would give 3/2008
    // — still a plausible number, and a limiter that throttles a user for calls
    // they made with an API key.
    expect(session.requests).toBe(1);
    expect(session.tokens).toBe(10);
  });
});

describe('credit spend', () => {
  it('uses recorded credits when present and a token estimate when not', async () => {
    const oxyUserId = 'aku-credits-mix';
    // Recorded credits win outright.
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 12, tokensUsed: 50_000 }));
    // No credits: ceil(2500/1000) = 3.
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 0, tokensUsed: 2500 }));
    // No credits, under a thousand tokens: floored at 1, not 0.
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 0, tokensUsed: 10 }));

    const total = await creditSpendTotal(db, oxyUserId, minutesAgo(30));
    expect(total).toBe(16);
    expect(typeof total).toBe('number');
  });

  it('excludes rows that spent NEITHER credits nor tokens', async () => {
    const oxyUserId = 'aku-credits-free';
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 0, tokensUsed: 0 }));
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 0, tokensUsed: 0 }));

    /**
     * The filter and the `greatest(..., 1)` floor have to travel together. With
     * the filter dropped, each of these free rows would contribute one phantom
     * credit through the floor — turning a user who spent nothing into a user
     * who spent two, which is exactly the input the anomaly detector divides by.
     */
    expect(await creditSpendTotal(db, oxyUserId, minutesAgo(30))).toBe(0);
    expect(await creditSpendByDay(db, oxyUserId, minutesAgo(30))).toEqual([]);
  });

  it('bounds the day series above when an upper limit is given', async () => {
    const oxyUserId = 'aku-credits-window';
    const day = 24 * 60 * MINUTE;
    const cutoff = new Date(Date.now() - day);
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 5, timestamp: new Date(Date.now() - 2 * day) }));
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 7, timestamp: minutesAgo(1) }));

    const bounded = await creditSpendByDay(db, oxyUserId, new Date(Date.now() - 5 * day), cutoff);
    expect(bounded).toHaveLength(1);
    expect(bounded[0].used).toBe(5);

    // Unbounded sees both — so the single row above is the upper bound working,
    // not a query that reads one day whatever it is asked.
    const unbounded = await creditSpendByDay(db, oxyUserId, new Date(Date.now() - 5 * day));
    expect(unbounded).toHaveLength(2);
  });
});

describe('deletion', () => {
  it('deletes an app\'s usage only for the OWNER who asked', async () => {
    const appId = 'aku-del-app';
    await recordApiKeyUsage(db, usage({ appId, oxyUserId: 'owner-1' }));
    await recordApiKeyUsage(db, usage({ appId, oxyUserId: 'owner-2' }));

    // The owner check is the only thing stopping one developer deleting
    // another's records by guessing an app id.
    expect(await deleteUsageForApp(db, appId, 'owner-1')).toBe(1);

    const left = await db.select().from(apiKeyUsage).where(eq(apiKeyUsage.appId, appId));
    expect(left).toHaveLength(1);
    expect(left[0].oxyUserId).toBe('owner-2');
  });

  it('deletes a key\'s usage only for the OWNER who asked', async () => {
    const apiKeyId = 'aku-del-key';
    await recordApiKeyUsage(db, usage({ apiKeyId, oxyUserId: 'owner-3' }));
    await recordApiKeyUsage(db, usage({ apiKeyId, oxyUserId: 'owner-4' }));

    expect(await deleteUsageForKey(db, apiKeyId, 'owner-3')).toBe(1);
    const left = await db.select().from(apiKeyUsage).where(eq(apiKeyUsage.apiKeyId, apiKeyId));
    expect(left).toHaveLength(1);
    expect(left[0].oxyUserId).toBe('owner-4');
  });
});
