import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  creditSpendByDay,
  creditSpendTotal,
  creditSpendWindow,
  recordApiKeyUsage,
  usageWindow,
  type NewApiKeyUsage,
} from '../telemetry/apiKeyUsageRepository';
import { apiKeyUsage } from '../schema/telemetry';

/**
 * `api_key_usage`, against a real server.
 *
 * This one table backs rate limiting and credit spend, and each fails
 * PLAUSIBLY: a limiter comparing `"1500"` to a ceiling lets traffic through,
 * and a day bucket in the wrong time zone moves usage between columns of a
 * chart.
 *
 * Ids are namespaced per test and every read is windowed, because the pgdb suite
 * shares one database.
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
  authType: 'session',
  endpoint: '/v1/chat',
  method: 'POST',
  statusCode: 200,
  tokensUsed: 100,
  creditsUsed: 0,
  responseTimeMs: 50,
  timestamp: minutesAgo(1),
  ...over,
});

describe('day buckets', () => {
  it('buckets by UTC, not by the session time zone', async () => {
    const oxyUserId = 'aku-user-utc';

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

    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 1, timestamp: justAfterMidnight }));

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
            from ${apiKeyUsage} where ${apiKeyUsage.oxyUserId} = ${oxyUserId}`,
      );
      expect(naive.day).not.toBe(expectedDay);

      const days = await creditSpendByDay(tx, oxyUserId, new Date(anchor - 24 * 60 * MINUTE));
      expect(days).toHaveLength(1);
      expect(days[0]._id).toBe(expectedDay);
      expect(days[0].used).toBe(1);
    });
  });

  it('orders days oldest-first and keys them as _id', async () => {
    const oxyUserId = 'aku-user-order';
    const day = 24 * 60 * MINUTE;
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 1, timestamp: new Date(Date.now() - 2 * day) }));
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 1, timestamp: new Date(Date.now() - 1 * day) }));

    const days = await creditSpendByDay(db, oxyUserId, new Date(Date.now() - 5 * day));
    expect(days).toHaveLength(2);
    expect(days[0]._id < days[1]._id).toBe(true);
    // `_id`, not `date` — the client destructures the Mongo `$group` key name.
    expect(days[0]).toHaveProperty('_id');
    expect(typeof days[0].used).toBe('number');
  });
});

describe('the rate-limit window', () => {
  it('counts and sums the same window in one answer', async () => {
    const oxyUserId = 'aku-rl-window';
    const subject = { oxyUserId, authType: 'session' as const };
    await recordApiKeyUsage(db, usage({ oxyUserId, tokensUsed: 700, timestamp: minutesAgo(0) }));
    await recordApiKeyUsage(db, usage({ oxyUserId, tokensUsed: 800, timestamp: minutesAgo(0) }));
    // Outside the one-minute window, inside the day.
    await recordApiKeyUsage(db, usage({ oxyUserId, tokensUsed: 5000, timestamp: minutesAgo(30) }));

    const minute = await usageWindow(db, subject, new Date(Date.now() - MINUTE));
    expect(minute.requests).toBe(2);
    expect(minute.tokens).toBe(1500);
    /**
     * The limiter compares this against a numeric ceiling. As a string, "1500"
     * is LESS than "500" lexicographically, so a missing cast does not merely
     * look odd — it silently raises the limit.
     */
    expect(typeof minute.tokens).toBe('number');

    const day = await usageWindow(db, subject, new Date(Date.now() - 24 * 60 * MINUTE));
    expect(day.requests).toBe(3);
    expect(day.tokens).toBe(6500);
  });

  it('separates a session user\'s budget from their other traffic', async () => {
    const oxyUserId = 'aku-rl-user';
    await recordApiKeyUsage(db, usage({ oxyUserId, authType: 'session', tokensUsed: 10 }));
    await recordApiKeyUsage(db, usage({ oxyUserId, authType: 'api_key', tokensUsed: 999 }));
    await recordApiKeyUsage(db, usage({ oxyUserId, authType: 'internal', tokensUsed: 999 }));

    const session = await usageWindow(db, { oxyUserId, authType: 'session' }, minutesAgo(30));
    // Only the session row. Dropping the `authType` predicate would give 3/2008
    // — still a plausible number, and a limiter that throttles a user for calls
    // made on their behalf (or recorded historically under a retired key).
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

describe('the rolling spend window', () => {
  it('sums the window and names its oldest spending turn, ignoring what fell out of it', async () => {
    const oxyUserId = 'aku-spend-window';
    // Outside the window: not counted, and not the oldest.
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 40, timestamp: minutesAgo(400) }));
    const oldest = minutesAgo(200);
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 7, timestamp: oldest }));
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 5, timestamp: minutesAgo(10) }));
    // A free row inside the window cannot be the oldest SPENDING turn.
    await recordApiKeyUsage(db, usage({ oxyUserId, creditsUsed: 0, tokensUsed: 0, timestamp: minutesAgo(250) }));

    const window = await creditSpendWindow(db, oxyUserId, minutesAgo(300));
    expect(window.used).toBe(12);
    expect(window.oldest?.getTime()).toBe(oldest.getTime());
  });

  it('is empty, with no oldest turn, for somebody who spent nothing', async () => {
    expect(await creditSpendWindow(db, 'aku-spend-window-none', minutesAgo(300))).toEqual({ used: 0, oldest: null });
  });
});
