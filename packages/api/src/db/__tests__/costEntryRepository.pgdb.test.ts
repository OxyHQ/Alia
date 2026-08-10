import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  aggregateModelEfficiency,
  aggregateTopUsersByCost,
  countDistinctCostEntryUsers,
  insertCostEntry,
  selectRecentCostEntries,
} from '../usage/costEntryRepository';
import {
  getGlobalCostStats,
  getUserCostSummary,
  getUserDashboardData,
  recordCost,
} from '../../lib/cost-tracker';

/**
 * `cost_entries`, against a real server.
 *
 * ## Why the fixtures are seeded rather than assumed
 *
 * Nothing in this repository calls `recordCost` — measured repo-wide — so the
 * table is empty in production and `getGlobalCostStats` returns zeros whether the
 * port works or not. There is no post-cutover check available: a correct read of
 * an empty table and a broken switch are the same answer. So every case here
 * seeds its own rows and asserts a NON-ZERO result, which is what makes a zero
 * mean "filtered" rather than "there was nothing there".
 *
 * ## Windows and ids are namespaced, because the suite shares one database
 *
 * `getGlobalCostStats` and `aggregateModelEfficiency` read the WHOLE table, so
 * every global assertion is confined to a disjoint historical window or to alias
 * model ids only this file writes. Instants are RELATIVE to now: an absolute
 * fixture date is a time bomb that detonates in a sibling file. (`cost_entries`
 * is deliberately not an expiry target — see `schema/usage.ts` — so the sweep
 * cannot reap these, but the discipline holds regardless.)
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

/**
 * `davinci` is priced $20 per 1M tokens each way in `MODEL_PRICING`, so a
 * 1,000,000-token request costs exactly $20 — an exact binary fraction, which
 * matters because `cost_usd` is `double precision` and an inexact fixture would
 * make every assertion a tolerance argument.
 */
const PAID_MODEL = 'davinci';
/** Absent from `MODEL_PRICING`, so `getModelPricing` falls back and the cost is 0. */
const FREE_MODEL = 'ce-test-unpriced-model';

async function seed(row: {
  userId: string;
  aliasModelId: string;
  actualModelId?: string;
  actualProvider?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: Date;
  savedFromCache?: boolean;
  sessionId?: string | null;
}): Promise<void> {
  await insertCostEntry(db, {
    userId: row.userId,
    sessionId: row.sessionId ?? null,
    aliasModelId: row.aliasModelId,
    actualProvider: row.actualProvider ?? 'ce-provider',
    actualModelId: row.actualModelId ?? PAID_MODEL,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.inputTokens + row.outputTokens,
    costUsd: row.costUsd,
    savedFromCache: row.savedFromCache ?? false,
    timestamp: row.timestamp,
  });
}

describe('recordCost', () => {
  it('writes an entry that reads back, priced from the model table', async () => {
    const userId = 'ce-record-roundtrip';

    // 1,000,000 input tokens at $20/1M = $20.00 exactly.
    await recordCost(userId, 'alia-v1-pro', 'ce-provider', PAID_MODEL, 1_000_000, 0, false, 'sess-1');

    const summary = await getUserCostSummary(userId);

    /**
     * `recordCost` SWALLOWS its errors and logs them, which is why this asserts
     * the row is present rather than that the call resolved. A failed insert
     * returns normally and leaves the summary at zero — indistinguishable from a
     * user who never spent anything, and the reason every figure below is
     * checked against a value only a real write produces.
     */
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalSpent).toBe(20);
    expect(summary.totalTokens).toBe(1_000_000);
    expect(summary.costByModel).toEqual({ 'alia-v1-pro': 20 });
    expect(summary.tokensByModel).toEqual({ 'alia-v1-pro': 1_000_000 });
  });

  it('records a zero cost for a model the pricing table does not know, and counts it as free-tier saving', async () => {
    const userId = 'ce-record-free';

    await recordCost(userId, 'alia-lite', 'ce-provider', FREE_MODEL, 1_000_000, 1_000_000);

    const summary = await getUserCostSummary(userId);
    expect(summary.totalSpent).toBe(0);
    expect(summary.totalRequests).toBe(1);
    // 2.50 + 10.00 per 1M against the reference paid model.
    expect(summary.freeTierSavings).toBe(12.5);
    expect(summary.cacheSavings).toBe(0);
  });

  it('re-prices a cache hit into cacheSavings without charging for it', async () => {
    const userId = 'ce-record-cached';

    await recordCost(userId, 'alia-v1', 'ce-provider', PAID_MODEL, 1_000_000, 0, true);

    const summary = await getUserCostSummary(userId);
    // The row still carries its computed cost; `savedFromCache` is what makes
    // the same figure ALSO count as a saving.
    expect(summary.cacheSavings).toBe(20);
    expect(summary.totalSpent).toBe(20);
  });
});

describe('getUserCostSummary windowing', () => {
  it('counts only entries inside the window, and the window is what excludes them', async () => {
    const userId = 'ce-window';
    await seed({ userId, aliasModelId: 'ce-window-model', inputTokens: 10, outputTokens: 0, costUsd: 1, timestamp: daysAgo(55) });
    await seed({ userId, aliasModelId: 'ce-window-model', inputTokens: 10, outputTokens: 0, costUsd: 2, timestamp: daysAgo(45) });

    const inside = await getUserCostSummary(userId, daysAgo(60), daysAgo(50));
    expect(inside.totalRequests).toBe(1);
    expect(inside.totalSpent).toBe(1);

    // The positive control for the window: the same call with no bounds sees
    // both rows, so "one row" above is filtering rather than a failed seed.
    const unbounded = await getUserCostSummary(userId);
    expect(unbounded.totalRequests).toBe(2);
    expect(unbounded.totalSpent).toBe(3);
  });
});

describe('aggregateTopUsersByCost', () => {
  const WINDOW_START = () => daysAgo(40);
  const WINDOW_END = () => daysAgo(30);
  const at = () => daysAgo(35);

  it('sums across rows and returns NUMBERS, not the strings int8 decodes to', async () => {
    const userId = 'ce-top-types';
    // TWO rows, deliberately. `sum(integer)` returns `bigint`, which postgres.js
    // decodes as a STRING while drizzle types it `number` — so a missing cast
    // gives "1000" + "2000" = "10002000" here, and an indistinguishable "1000"
    // if only one row were seeded.
    await seed({ userId, aliasModelId: 'ce-top-types-model', inputTokens: 1000, outputTokens: 0, costUsd: 1.5, timestamp: at() });
    await seed({ userId, aliasModelId: 'ce-top-types-model', inputTokens: 2000, outputTokens: 0, costUsd: 2.5, timestamp: at() });

    const rows = await aggregateTopUsersByCost(db, { limit: 50, startDate: WINDOW_START(), endDate: WINDOW_END() });
    const mine = rows.find((r) => r.userId === userId);
    if (!mine) throw new Error('seeded user missing from the aggregate');

    expect(typeof mine.totalTokens).toBe('number');
    expect(typeof mine.totalRequests).toBe('number');
    expect(typeof mine.totalSpent).toBe('number');
    expect(mine.totalTokens).toBe(3000);
    expect(mine.totalRequests).toBe(2);
    expect(mine.totalSpent).toBe(4);
  });

  it('orders by spend descending and honours the limit', async () => {
    const window = { startDate: daysAgo(20), endDate: daysAgo(10) };
    const at15 = daysAgo(15);
    await seed({ userId: 'ce-rank-small', aliasModelId: 'ce-rank-model', inputTokens: 1, outputTokens: 0, costUsd: 1, timestamp: at15 });
    await seed({ userId: 'ce-rank-big', aliasModelId: 'ce-rank-model', inputTokens: 1, outputTokens: 0, costUsd: 100, timestamp: at15 });
    await seed({ userId: 'ce-rank-mid', aliasModelId: 'ce-rank-model', inputTokens: 1, outputTokens: 0, costUsd: 50, timestamp: at15 });

    const all = await aggregateTopUsersByCost(db, { limit: 50, ...window });
    const ranked = all.filter((r) => r.userId.startsWith('ce-rank-')).map((r) => r.userId);
    expect(ranked).toEqual(['ce-rank-big', 'ce-rank-mid', 'ce-rank-small']);

    // The limit must cut from the EXPENSIVE end, which only holds if the sort
    // happens in the database rather than after the slice.
    const top = await aggregateTopUsersByCost(db, { limit: 1, ...window });
    expect(top).toHaveLength(1);
    expect(top[0]?.userId).toBe('ce-rank-big');
  });
});

describe('countDistinctCostEntryUsers', () => {
  it('counts accounts, not rows', async () => {
    const window = { startDate: daysAgo(100), endDate: daysAgo(90) };
    const at95 = daysAgo(95);
    await seed({ userId: 'ce-distinct-a', aliasModelId: 'ce-distinct-model', inputTokens: 1, outputTokens: 0, costUsd: 1, timestamp: at95 });
    await seed({ userId: 'ce-distinct-a', aliasModelId: 'ce-distinct-model', inputTokens: 1, outputTokens: 0, costUsd: 1, timestamp: at95 });
    await seed({ userId: 'ce-distinct-b', aliasModelId: 'ce-distinct-model', inputTokens: 1, outputTokens: 0, costUsd: 1, timestamp: at95 });

    const users = await countDistinctCostEntryUsers(db, window);
    expect(typeof users).toBe('number');
    // Three rows, two accounts. A `count(*)` would say 3.
    expect(users).toBe(2);
  });
});

describe('getGlobalCostStats', () => {
  it('splits spend by alias and by provider, and the provider split is the internal one', async () => {
    const window = { start: daysAgo(80), end: daysAgo(70) };
    const at75 = daysAgo(75);
    await seed({ userId: 'ce-global-1', aliasModelId: 'ce-global-alias-a', actualProvider: 'ce-global-prov-x', inputTokens: 100, outputTokens: 0, costUsd: 3, timestamp: at75 });
    await seed({ userId: 'ce-global-1', aliasModelId: 'ce-global-alias-b', actualProvider: 'ce-global-prov-x', inputTokens: 100, outputTokens: 0, costUsd: 4, timestamp: at75 });
    await seed({ userId: 'ce-global-2', aliasModelId: 'ce-global-alias-a', actualProvider: 'ce-global-prov-y', inputTokens: 100, outputTokens: 0, costUsd: 5, timestamp: at75 });

    const stats = await getGlobalCostStats(window.start, window.end);

    expect(stats.totalRequests).toBe(3);
    expect(stats.totalRevenue).toBe(12);
    expect(stats.totalTokens).toBe(300);
    expect(stats.uniqueUsers).toBe(2);
    // Two different groupings of the SAME rows — a port that grouped by one and
    // labelled it the other would still total correctly.
    expect(stats.costByAliasModel).toEqual({ 'ce-global-alias-a': 8, 'ce-global-alias-b': 4 });
    expect(stats.costByActualProvider).toEqual({ 'ce-global-prov-x': 7, 'ce-global-prov-y': 5 });
    expect(stats.avgCostPerRequest).toBe(4);
  });

  it('returns totals as numbers so a caller can do arithmetic on them', async () => {
    const window = { start: daysAgo(120), end: daysAgo(110) };
    await seed({ userId: 'ce-global-types', aliasModelId: 'ce-global-types-model', inputTokens: 1500, outputTokens: 500, costUsd: 1, timestamp: daysAgo(115) });
    await seed({ userId: 'ce-global-types', aliasModelId: 'ce-global-types-model', inputTokens: 1500, outputTokens: 500, costUsd: 1, timestamp: daysAgo(115) });

    const stats = await getGlobalCostStats(window.start, window.end);
    expect(typeof stats.totalTokens).toBe('number');
    expect(typeof stats.uniqueUsers).toBe('number');
    expect(stats.totalTokens).toBe(4000);
    expect(stats.totalTokens + 1).toBe(4001);
  });
});

describe('aggregateModelEfficiency', () => {
  it('computes cost per 1000 tokens and orders cheapest first', async () => {
    const at = daysAgo(140);
    // $20 over 1,000,000 tokens = $0.02 per 1k.
    await seed({ userId: 'ce-eff', aliasModelId: 'ce-eff-expensive', inputTokens: 1_000_000, outputTokens: 0, costUsd: 20, timestamp: at });
    // $1 over 1,000,000 tokens = $0.001 per 1k.
    await seed({ userId: 'ce-eff', aliasModelId: 'ce-eff-cheap', inputTokens: 1_000_000, outputTokens: 0, costUsd: 1, timestamp: at });

    const rows = await aggregateModelEfficiency(db);
    const mine = rows.filter((r) => r.aliasModelId.startsWith('ce-eff-'));
    expect(mine.map((r) => r.aliasModelId)).toEqual(['ce-eff-cheap', 'ce-eff-expensive']);

    const expensive = mine.find((r) => r.aliasModelId === 'ce-eff-expensive');
    expect(expensive?.avgCostPer1kTokens).toBeCloseTo(0.02, 10);
    expect(expensive?.totalCost).toBe(20);
    expect(typeof expensive?.totalRequests).toBe('number');
    expect(expensive?.totalRequests).toBe(1);
  });

  it('answers 0 for a model whose rows recorded no tokens, rather than dividing by zero', async () => {
    // The `nullif` guard, and the reason it is not decoration: without it this
    // statement raises `division_by_zero` and the whole call fails, taking the
    // priced models down with it.
    await seed({ userId: 'ce-eff-zero-user', aliasModelId: 'ce-eff-zerotokens', inputTokens: 0, outputTokens: 0, costUsd: 0, timestamp: daysAgo(141) });

    const rows = await aggregateModelEfficiency(db);
    const zero = rows.find((r) => r.aliasModelId === 'ce-eff-zerotokens');
    expect(zero).toBeDefined();
    expect(zero?.avgCostPer1kTokens).toBe(0);
  });
});

describe('selectRecentCostEntries', () => {
  it('returns one account newest first, capped at the limit', async () => {
    const userId = 'ce-recent';
    for (let i = 1; i <= 12; i++) {
      await seed({ userId, aliasModelId: `ce-recent-${String(i)}`, inputTokens: i, outputTokens: 0, costUsd: i, timestamp: daysAgo(200 + i) });
    }
    await seed({ userId: 'ce-recent-other', aliasModelId: 'ce-recent-foreign', inputTokens: 1, outputTokens: 0, costUsd: 999, timestamp: daysAgo(200) });

    const rows = await selectRecentCostEntries(db, userId, 10);
    expect(rows).toHaveLength(10);
    // `daysAgo(201)` is the newest of the twelve; `daysAgo(212)` the oldest, and
    // the two the limit must drop are 211 and 212.
    expect(rows.map((r) => r.aliasModelId)).toEqual([
      'ce-recent-1', 'ce-recent-2', 'ce-recent-3', 'ce-recent-4', 'ce-recent-5',
      'ce-recent-6', 'ce-recent-7', 'ce-recent-8', 'ce-recent-9', 'ce-recent-10',
    ]);
    expect(rows.every((r) => r.userId === userId)).toBe(true);
  });

  it('is exposed through getUserDashboardData under this module\'s own field spelling', async () => {
    const userId = 'ce-dashboard';
    await seed({ userId, aliasModelId: 'ce-dashboard-model', inputTokens: 100, outputTokens: 0, costUsd: 7, timestamp: daysAgo(1) });

    const data = await getUserDashboardData(userId);
    expect(data.recentActivity).toHaveLength(1);
    // The column is `cost_usd` and drizzle hands back `costUsd`; the exported
    // shape has always been `costUSD`. This is the rename, asserted.
    expect(data.recentActivity[0]?.costUSD).toBe(7);
    expect(data.summary.totalSpent).toBe(7);
  });
});
