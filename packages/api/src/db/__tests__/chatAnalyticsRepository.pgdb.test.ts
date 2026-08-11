import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  aggregateCreditsByDay,
  aggregateUsageByDay,
  aggregateUsageByModel,
  insertChatAnalytics,
} from '../usage/chatAnalyticsRepository';
import { chatAnalytics } from '../schema/usage';

/**
 * `chat_analytics`, against a real server.
 *
 * Every case is scoped to its own `oxy_user_id`, which is what all three
 * aggregates filter on — so this file cannot see another file's rows and another
 * file cannot perturb it. Instants are relative to now.
 *
 * `created_at` is a `defaultNow()` column, so the day-bucket cases set it
 * explicitly with `db.update`; the repository has no reason to accept a
 * timestamp and inventing one would be testing a parameter nothing uses.
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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
/** Wide enough that every fixture below falls inside it. */
const SINCE = () => daysAgo(365);

let seq = 0;
async function seed(row: {
  oxyUserId: string;
  model: string;
  aliaModelId?: string;
  totalTokens?: number;
  latencyMs?: number;
  createdAt?: Date;
}): Promise<void> {
  const marker = `ca-marker-${String(++seq)}`;
  await insertChatAnalytics(db, {
    oxyUserId: row.oxyUserId,
    conversationId: marker,
    model: row.model,
    aliaModelId: row.aliaModelId,
    provider: 'ca-provider',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: row.totalTokens ?? 0,
    latencyMs: row.latencyMs ?? 0,
    platform: 'app',
    skillId: undefined,
  });
  if (row.createdAt) {
    await db
      .update(chatAnalytics)
      .set({ createdAt: row.createdAt })
      .where(sql`${chatAnalytics.conversationId} = ${marker}`);
  }
}

describe('insertChatAnalytics', () => {
  it('stores the columns the table gained, not just the ones it already had', async () => {
    const oxyUserId = 'ca-columns';
    await insertChatAnalytics(db, {
      oxyUserId,
      conversationId: 'ca-conv-1',
      model: 'gpt-4o',
      aliaModelId: 'alia-v1-pro',
      provider: 'ca-provider',
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      latencyMs: 44,
      platform: 'web',
      skillId: 'ca-skill-1',
    });

    const [row] = await db
      .select()
      .from(chatAnalytics)
      .where(sql`${chatAnalytics.oxyUserId} = ${oxyUserId}`);
    if (!row) throw new Error('no row written');

    /**
     * `conversation_id`, `alia_model_id` and `skill_id` were absent from the
     * table when it landed while the hook wrote all three. A port without them
     * type-checks, inserts cleanly and throws the values away.
     */
    expect(row.conversationId).toBe('ca-conv-1');
    expect(row.aliaModelId).toBe('alia-v1-pro');
    expect(row.skillId).toBe('ca-skill-1');
    // And the provider model stays distinct from the alias.
    expect(row.model).toBe('gpt-4o');
    expect(row.platform).toBe('web');
    expect(row.promptTokens).toBe(11);
  });
});

describe('aggregateUsageByModel', () => {
  it('groups under the ALIA alias, not the provider model id', async () => {
    const oxyUserId = 'ca-alias-grouping';
    await seed({ oxyUserId, model: 'gpt-4o', aliaModelId: 'alia-v1-pro', totalTokens: 10 });
    await seed({ oxyUserId, model: 'claude-sonnet-4', aliaModelId: 'alia-v1-pro', totalTokens: 20 });

    const rows = await aggregateUsageByModel(db, oxyUserId, SINCE());

    /**
     * The load-bearing assertion of this whole table. Two rows served by two
     * DIFFERENT providers under ONE Alia alias must collapse to one group named
     * by the alias — because the route resolves that key through
     * `getAliaModel()` and DROPS whatever will not resolve. Grouped by `model`
     * this returns two groups named `gpt-4o` and `claude-sonnet-4`, neither of
     * which resolves, and the route answers `models: []` — a plausible "no usage
     * yet" for a user who has plenty.
     */
    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe('alia-v1-pro');
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.totalTokens).toBe(30);
  });

  it('falls back to the provider model when no alias was recorded', async () => {
    const oxyUserId = 'ca-alias-fallback';
    await seed({ oxyUserId, model: 'gpt-4o', totalTokens: 5 });

    const rows = await aggregateUsageByModel(db, oxyUserId, SINCE());
    // `coalesce(alia_model_id, model)`, which is the source's `$ifNull`. A row
    // predating the alias must still appear rather than grouping under NULL.
    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe('gpt-4o');
  });

  it('orders busiest first and returns NUMBERS for every aggregate', async () => {
    const oxyUserId = 'ca-model-order';
    await seed({ oxyUserId, model: 'm', aliaModelId: 'alia-busy', totalTokens: 100, latencyMs: 200 });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'alia-busy', totalTokens: 300, latencyMs: 400 });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'alia-quiet', totalTokens: 1, latencyMs: 10 });

    const rows = await aggregateUsageByModel(db, oxyUserId, SINCE());
    expect(rows.map((r) => r._id)).toEqual(['alia-busy', 'alia-quiet']);

    const busy = rows[0];
    /**
     * Three separate decodings, three separate ways to get a string:
     * `count(*)` and `sum(integer)` are `bigint`, and **`avg(integer)` is
     * `numeric`** — the one that does not look like the others. Two rows are
     * seeded for `alia-busy` precisely so a concatenation is visible: without
     * the casts `totalTokens` comes back `"100300"` and `avgLatency` `"300.00"`.
     */
    expect(typeof busy?.count).toBe('number');
    expect(typeof busy?.totalTokens).toBe('number');
    expect(typeof busy?.avgLatency).toBe('number');
    expect(busy?.totalTokens).toBe(400);
    expect(busy?.avgLatency).toBe(300);
    expect(busy?.totalTokens + 1).toBe(401);
  });
});

describe('aggregateUsageByDay', () => {
  it('buckets by UTC calendar day and orders oldest first', async () => {
    const oxyUserId = 'ca-by-day';
    // Noon UTC on three consecutive days, far enough back that "today" cannot
    // drift into the window as the suite runs.
    const day = (n: number) => {
      const d = new Date(Date.now() - n * DAY_MS);
      d.setUTCHours(12, 0, 0, 0);
      return d;
    };
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 10, latencyMs: 100, createdAt: day(30) });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 20, latencyMs: 300, createdAt: day(30) });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 5, latencyMs: 50, createdAt: day(29) });

    const rows = await aggregateUsageByDay(db, oxyUserId, SINCE());
    expect(rows).toHaveLength(2);

    const labelOf = (n: number) => day(n).toISOString().slice(0, 10);
    expect(rows.map((r) => r._id)).toEqual([labelOf(30), labelOf(29)]);
    expect(rows[0]?.conversations).toBe(2);
    expect(rows[0]?.totalTokens).toBe(30);
    expect(rows[0]?.avgLatency).toBe(200);
  });

  it('labels the bucket in UTC even when the session timezone is not', async () => {
    const oxyUserId = 'ca-utc-bucket';
    // 23:30 UTC. In Kiritimati (UTC+14) that is 13:30 the NEXT day, so the two
    // readings disagree — which is the whole point.
    const instant = new Date(Date.now() - 60 * DAY_MS);
    instant.setUTCHours(23, 30, 0, 0);
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 1, createdAt: instant });

    const utcLabel = instant.toISOString().slice(0, 10);
    const localLabel = new Date(instant.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(localLabel).not.toBe(utcLabel); // the fixture is only useful if they differ

    /**
     * `set local` inside a transaction, because postgres.js pools connections
     * and a bare `SET` could land on one the query never uses. Mongo's
     * `$dateToString` with no `timezone` is UTC; `to_char` on a `timestamptz`
     * uses the SESSION's zone, so without `at time zone 'UTC'` this bucket
     * silently shifts a day on any server not running UTC.
     */
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'Pacific/Kiritimati'`);
      return aggregateUsageByDay(tx as unknown as ApiDatabase, oxyUserId, SINCE());
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?._id).toBe(utcLabel);
  });
});

describe('aggregateCreditsByDay', () => {
  it('returns tokens and a count per UTC day, oldest first', async () => {
    const oxyUserId = 'ca-credits';
    const day = (n: number) => {
      const d = new Date(Date.now() - n * DAY_MS);
      d.setUTCHours(9, 0, 0, 0);
      return d;
    };
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 7, createdAt: day(11) });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 3, createdAt: day(10) });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 4, createdAt: day(10) });

    const rows = await aggregateCreditsByDay(db, oxyUserId, SINCE());
    expect(rows.map((r) => r._id)).toEqual([
      day(11).toISOString().slice(0, 10),
      day(10).toISOString().slice(0, 10),
    ]);
    expect(rows[0]?.totalTokens).toBe(7);
    expect(rows[1]?.totalTokens).toBe(7);
    expect(rows[1]?.conversations).toBe(2);
    expect(typeof rows[1]?.totalTokens).toBe('number');
  });
});

describe('the window', () => {
  it('excludes rows older than `since`, and something is there to exclude', async () => {
    const oxyUserId = 'ca-window';
    const old = new Date(Date.now() - 400 * DAY_MS);
    const recent = new Date(Date.now() - 2 * DAY_MS);
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 111, createdAt: old });
    await seed({ oxyUserId, model: 'm', aliaModelId: 'a', totalTokens: 222, createdAt: recent });

    const inWindow = await aggregateUsageByModel(db, oxyUserId, daysAgo(30));
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]?.totalTokens).toBe(222);

    // Positive control: widen the window and the excluded row reappears, so the
    // assertion above is filtering rather than a seed that never landed.
    const wider = await aggregateUsageByModel(db, oxyUserId, daysAgo(500));
    expect(wider[0]?.totalTokens).toBe(333);
    expect(wider[0]?.count).toBe(2);
  });

  it('answers with no rows rather than an error when nothing matches', async () => {
    const rows = await aggregateUsageByDay(db, 'ca-nobody-at-all', SINCE());
    expect(rows).toEqual([]);
  });
});
