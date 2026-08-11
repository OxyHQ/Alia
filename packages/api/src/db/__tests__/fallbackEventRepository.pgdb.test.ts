import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  failuresByModel,
  mostFailedProviders,
  recentFailures,
  recordFallbackEvent,
  summariseFallbacks,
  topFailureReasons,
} from '../telemetry/fallbackEventRepository';
import { fallbackEvents } from '../schema/telemetry';

/**
 * `fallback_events`, against a real server.
 *
 * These are analytics reads whose wrong answers are all PLAUSIBLE: a count that
 * arrives as a string, an average taken over the wrong denominator, a group that
 * silently drops the rows with no attempts. None of them error. So the cases
 * below assert types as well as values, and every "this row is included" has a
 * companion "and that one is not".
 *
 * Alias models are namespaced per test — the pgdb suite shares one database and
 * every read here is a GROUP BY over the whole table, so an unqualified name
 * would fold another test's rows into this one's answer. Every read is
 * additionally windowed by `since`, which is what makes that isolation work.
 *
 * Instants are relative to `now`. `fallback_events` is a 30-day expiry target
 * and several files sweep the full registry, so an absolute fixture date would
 * be reaped out from under a sibling file one day without warning.
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

const attempt = (provider: string, model: string, reason: string, latencyMs: number) => ({
  provider,
  model,
  error: `${provider} said no`,
  reason,
  latencyMs,
});

async function seed(
  aliasModel: string,
  opts: {
    success: boolean;
    attempts: ReturnType<typeof attempt>[];
    totalLatencyMs?: number;
    minutesAgo?: number;
  },
) {
  await recordFallbackEvent(db, {
    timestamp: minutesAgo(opts.minutesAgo ?? 1),
    aliasModel,
    attempts: opts.attempts,
    finalProvider: opts.success ? opts.attempts.at(-1)?.provider ?? null : null,
    finalModel: null,
    success: opts.success,
    totalLatencyMs: opts.totalLatencyMs ?? 100,
  });
}

describe('recording', () => {
  it('stores the attempts array whole and reads it back as objects', async () => {
    const alias = 'fb-store';
    await seed(alias, {
      success: true,
      attempts: [attempt('p1', 'm1', 'timeout', 10), attempt('p2', 'm2', 'rate_limit', 20)],
      totalLatencyMs: 55,
    });

    const [row] = await db.select().from(fallbackEvents).where(eq(fallbackEvents.aliasModel, alias));
    expect(row.success).toBe(true);
    expect(row.totalLatencyMs).toBe(55);
    // `jsonb`, so it must survive the round trip as structure rather than text.
    expect(row.attempts).toHaveLength(2);
    expect((row.attempts as ReturnType<typeof attempt>[])[1].reason).toBe('rate_limit');
  });
});

describe('the summary', () => {
  it('counts successes and failures apart and averages the attempt count', async () => {
    const alias = 'fb-summary';
    const since = minutesAgo(30);
    await seed(alias, { success: false, attempts: [attempt('p1', 'm', 'timeout', 10)], totalLatencyMs: 100 });
    await seed(alias, {
      success: true,
      attempts: [attempt('p1', 'm', 'timeout', 10), attempt('p2', 'm', 'error', 20), attempt('p3', 'm', 'error', 30)],
      totalLatencyMs: 300,
    });

    // Scoped by re-reading through the per-model read, because the summary is
    // table-wide and other tests' rows share the window.
    const [mine] = (await failuresByModel(db, since)).filter((r) => r.aliasModel === alias);
    expect(mine).toBeDefined();
    expect(mine.totalEvents).toBe(2);
    expect(mine.failures).toBe(1);
    expect(mine.successes).toBe(1);
    expect(mine.avgAttempts).toBe(2); // (1 + 3) / 2
    expect(mine.fallbackRate).toBe(50);

    // And the table-wide summary is at least consistent with those two rows...
    const summary = await summariseFallbacks(db, since);
    expect(summary.totalEvents).toBeGreaterThanOrEqual(2);
    expect(summary.maxAttempts).toBeGreaterThanOrEqual(3);
    /**
     * ...and every number is a NUMBER. `count(*)` is bigint and
     * `avg(integer)` is numeric; postgres.js decodes both as strings while
     * drizzle types them `number`, so dropping the casts gives `"2"` here —
     * which passes any `toBeGreaterThanOrEqual` against a small number by
     * string comparison and fails only later, as concatenation.
     */
    expect(typeof summary.totalEvents).toBe('number');
    expect(typeof summary.successCount).toBe('number');
    expect(typeof summary.avgAttempts).toBe('number');
    expect(typeof summary.avgTotalLatencyMs).toBe('number');
    expect(typeof summary.maxAttempts).toBe('number');
  });

  it('returns zeros rather than nothing for a window with no events', async () => {
    // A far-future window cannot contain a relative-to-now fixture.
    const summary = await summariseFallbacks(db, new Date(Date.now() + 60 * MINUTE));
    expect(summary.totalEvents).toBe(0);
    expect(summary.avgAttempts).toBe(0);
    expect(summary.maxAttempts).toBe(0);
    // Mongo returned an empty array here and the route substituted an object.
    // Postgres returns the row, so "no rows" no longer needs telling apart from
    // "no traffic" at the call site.
    expect(typeof summary.totalEvents).toBe('number');
  });

  it('excludes events older than the window', async () => {
    const alias = 'fb-window';
    await seed(alias, { success: false, attempts: [attempt('p', 'm', 'old', 1)], minutesAgo: 120 });

    const wide = await failuresByModel(db, minutesAgo(240));
    expect(wide.find((r) => r.aliasModel === alias)).toBeDefined();

    // The negative half — without it, "absent" is also what a read returning
    // nothing at all would produce.
    const narrow = await failuresByModel(db, minutesAgo(10));
    expect(narrow.find((r) => r.aliasModel === alias)).toBeUndefined();
  });
});

describe('unwinding the attempts', () => {
  it('groups reasons ACROSS attempts, not across events', async () => {
    const alias = 'fb-reasons';
    const since = minutesAgo(30);
    // One event carrying three attempts, two of which share a reason. A query
    // that grouped by event rather than by attempt would report 1, not 2.
    await seed(alias, {
      success: false,
      attempts: [
        attempt('pA', 'm', 'fb-reason-shared', 100),
        attempt('pB', 'm', 'fb-reason-shared', 200),
        attempt('pC', 'm', 'fb-reason-lonely', 300),
      ],
    });

    const reasons = await topFailureReasons(db, since);
    const shared = reasons.find((r) => r.reason === 'fb-reason-shared');
    const lonely = reasons.find((r) => r.reason === 'fb-reason-lonely');
    expect(shared).toBeDefined();
    expect(lonely).toBeDefined();
    expect(shared?.count).toBe(2);
    expect(lonely?.count).toBe(1);
    expect(shared?.avgLatencyMs).toBe(150); // (100 + 200) / 2, rounded to 0dp
    expect(typeof shared?.count).toBe('number');
  });

  it('reports a provider\'s COMMONEST reason, not an arbitrary one', async () => {
    const alias = 'fb-topreason';
    const since = minutesAgo(30);
    /**
     * The deliberate behaviour change. Mongo built the reason list with `$push`
     * and took element 0 with no `$sort` anywhere, so it returned whichever
     * attempt the group happened to accumulate first.
     *
     * `fb-rare` is placed FIRST in every event precisely so an
     * arrival-order implementation would return it — this test fails against
     * the semantics that were ported away from, which is the only way to pin
     * that the change actually happened.
     */
    await seed(alias, {
      success: false,
      attempts: [
        attempt('fb-prov', 'm1', 'fb-rare', 10),
        attempt('fb-prov', 'm2', 'fb-common', 10),
        attempt('fb-prov', 'm2', 'fb-common', 10),
      ],
    });

    const providers = await mostFailedProviders(db, since);
    const mine = providers.find((p) => p.provider === 'fb-prov');
    expect(mine).toBeDefined();
    expect(mine?.failureCount).toBe(3);
    // Two DISTINCT models across three attempts — `$addToSet` then `$size`.
    expect(mine?.modelCount).toBe(2);
    expect(mine?.topReason).toBe('fb-common');
  });
});

describe('recent failures', () => {
  it('returns only failures, newest first, and never a success', async () => {
    const alias = 'fb-recent';
    const since = minutesAgo(60);
    await seed(alias, { success: false, attempts: [attempt('p', 'm', 'older-failure', 1)], minutesAgo: 20 });
    await seed(alias, { success: false, attempts: [attempt('p', 'm', 'newer-failure', 1)], minutesAgo: 5 });
    await seed(alias, { success: true, attempts: [attempt('p', 'm', 'ignored', 1)], minutesAgo: 1 });

    const rows = (await recentFailures(db, since, 100)).filter((r) => r.aliasModel === alias);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect((rows[0].attempts as ReturnType<typeof attempt>[])[0].reason).toBe('newer-failure');
    // The success is excluded — and it is the NEWEST row of the three, so a
    // filter that did nothing would have put it at the head.
    expect(rows.every((r) => r.success === false)).toBe(true);
  });

  it('honours the limit', async () => {
    const alias = 'fb-limit';
    for (let i = 0; i < 5; i += 1) {
      await seed(alias, { success: false, attempts: [attempt('p', 'm', `r${i}`, 1)] });
    }
    const rows = await recentFailures(db, minutesAgo(30), 3);
    expect(rows).toHaveLength(3);
  });
});
