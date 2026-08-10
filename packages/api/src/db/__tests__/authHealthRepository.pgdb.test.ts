import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  bucketedHour,
  incrementAuthFailure,
  incrementAuthSuccess,
  summariseAuthHealth,
} from '../telemetry/authHealthRepository';
import { authHealthMetrics } from '../schema/telemetry';

/**
 * `auth_health_metrics`, against a real server.
 *
 * The source store is gone, so there is no post-cutover check available: a
 * counter that never increments and a quiet hour look identical in production.
 * Every case here therefore fails if the repository silently does nothing, and
 * the fixtures are seeded by the code under test rather than assumed present.
 *
 * Methods are namespaced per test. The pgdb suite shares ONE database across
 * files and `(method, hour)` is a unique key, so an unqualified `'jwt'` would
 * collide with any other file that ever touches this table. Hours are computed
 * RELATIVE to now for the same reason a fixture instant must never be absolute:
 * `auth_health_metrics` is a 7-day expiry target and four files sweep the full
 * registry.
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

const HOUR_MS = 60 * 60 * 1000;
/** An hour bucket `n` hours before the current one — always inside any `since` window used below. */
const hoursAgo = (n: number) => bucketedHour(new Date(Date.now() - n * HOUR_MS));

/**
 * Through `eq()`, not a raw `sql` template.
 *
 * A bare `Date` interpolated into `sql` fails in the DRIVER, not the server —
 * `ERR_INVALID_ARG_TYPE: Received an instance of Date` — before the statement is
 * sent. The query builder routes the value through the column's own mapper and
 * has no such problem. (The alternative is an ISO string with an explicit
 * `::timestamptz` cast; the builder is the one that cannot be got wrong.)
 */
async function readBucket(method: string, hour: Date) {
  const [row] = await db
    .select()
    .from(authHealthMetrics)
    .where(and(eq(authHealthMetrics.method, method), eq(authHealthMetrics.hour, hour)));
  if (!row) throw new Error(`no bucket for ${method} at ${hour.toISOString()}`);
  return row;
}

describe('counting', () => {
  it('creates the bucket on the first success and ADDS on the second', async () => {
    const method = 'ahr-first';
    const hour = hoursAgo(0);

    await incrementAuthSuccess(db, method, hour);
    expect((await readBucket(method, hour)).successes).toBe(1);

    // The second call is what distinguishes an increment from an overwrite: a
    // repository that wrote `successes: 1` unconditionally passes the first
    // assertion and fails here.
    await incrementAuthSuccess(db, method, hour);
    expect((await readBucket(method, hour)).successes).toBe(2);
  });

  it('keeps successes and failures in the SAME bucket without either resetting the other', async () => {
    const method = 'ahr-mixed';
    const hour = hoursAgo(0);

    await incrementAuthSuccess(db, method, hour);
    await incrementAuthFailure(db, method, hour, new Date(), 'bad token');
    await incrementAuthSuccess(db, method, hour);

    const row = await readBucket(method, hour);
    expect(row.successes).toBe(2);
    expect(row.failures).toBe(1);
    // One row, not three — `(method, hour)` is the identity.
    const all = await db.select().from(authHealthMetrics).where(eq(authHealthMetrics.method, method));
    expect(all).toHaveLength(1);
  });

  it('separates buckets by hour', async () => {
    const method = 'ahr-buckets';
    await incrementAuthSuccess(db, method, hoursAgo(0));
    await incrementAuthSuccess(db, method, hoursAgo(1));

    const all = await db.select().from(authHealthMetrics).where(eq(authHealthMetrics.method, method));
    expect(all).toHaveLength(2);
  });

  it('does NOT erase an existing failure reason when a later failure has none', async () => {
    const method = 'ahr-reason';
    const hour = hoursAgo(0);

    await incrementAuthFailure(db, method, hour, new Date(), 'expired signature');
    await incrementAuthFailure(db, method, hour, new Date());

    const row = await readBucket(method, hour);
    expect(row.failures).toBe(2);
    // The conditional `$set` the Mongo version had. A repository that always
    // wrote the column would leave this null.
    expect(row.lastFailureReason).toBe('expired signature');
  });
});

describe('summarising', () => {
  it('sums across an ACTIVE method\'s buckets and reports the newest failure reason', async () => {
    const method = 'ahr-summary';
    const older = hoursAgo(3);
    const newer = hoursAgo(1);

    await incrementAuthSuccess(db, method, older);
    await incrementAuthSuccess(db, method, older);
    await incrementAuthFailure(db, method, older, new Date(Date.now() - 3 * HOUR_MS), 'older reason');
    await incrementAuthSuccess(db, method, newer);
    await incrementAuthFailure(db, method, newer, new Date(Date.now() - 1 * HOUR_MS), 'newer reason');

    const summary = await summariseAuthHealth(db, hoursAgo(24));
    const mine = summary.find((s) => s.method === method);

    // Vacuity floor for this whole file: if the summary read returns nothing,
    // every "expected value" assertion below would be skipped by the optional
    // chain and the test would pass having measured nothing.
    expect(mine).toBeDefined();
    expect(mine?.totalSuccesses).toBe(3);
    expect(mine?.totalFailures).toBe(2);
    // The port's deliberate behaviour change: Mongo's `$last` with no `$sort`
    // returned an arbitrary row's reason. This is the newest one.
    expect(mine?.lastFailureReason).toBe('newer reason');
  });

  it('excludes buckets older than the window', async () => {
    const method = 'ahr-window';
    await incrementAuthSuccess(db, method, hoursAgo(50));

    // Present when the window reaches back far enough...
    const wide = await summariseAuthHealth(db, hoursAgo(100));
    expect(wide.find((s) => s.method === method)?.totalSuccesses).toBe(1);

    // ...and absent when it does not. Without the first half, "absent" would
    // also be what a summary that reads nothing at all returns.
    const narrow = await summariseAuthHealth(db, hoursAgo(2));
    expect(narrow.find((s) => s.method === method)).toBeUndefined();
  });

  it('returns a method that has only FAILURES, rather than dropping it', async () => {
    const method = 'ahr-onlyfail';
    const hour = hoursAgo(0);
    await incrementAuthFailure(db, method, hour, new Date(), 'always broken');

    const summary = await summariseAuthHealth(db, hoursAgo(24));
    const mine = summary.find((s) => s.method === method);
    expect(mine).toBeDefined();
    expect(mine?.totalSuccesses).toBe(0);
    expect(mine?.totalFailures).toBe(1);
  });

  it('counts as NUMBERS, not concatenated strings', async () => {
    /**
     * `sum()` returns `bigint`/`numeric`, which postgres.js decodes as a STRING
     * while drizzle types it `number` — so `a + b` would be concatenation. Two
     * separate buckets are what make the two readings differ: 1 and 1 sum to 2
     * numerically and to "11" as text, and a single bucket cannot tell them
     * apart. The repository casts to `int` for exactly this reason.
     */
    const method = 'ahr-numeric';
    await incrementAuthSuccess(db, method, hoursAgo(1));
    await incrementAuthSuccess(db, method, hoursAgo(2));

    const summary = await summariseAuthHealth(db, hoursAgo(24));
    const mine = summary.find((s) => s.method === method);
    expect(mine?.totalSuccesses).toBe(2);
    expect(typeof mine?.totalSuccesses).toBe('number');
  });
});
