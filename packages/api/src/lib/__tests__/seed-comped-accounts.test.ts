import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The comp grant — a named Oxy account holds the most expensive plan of every
 * product without paying for it.
 *
 * The failure this suite exists for already happened once, in production: the
 * first version keyed on `req.user.username`, which `@oxyhq/core` never puts on
 * a request unless `loadUser: true` is passed, so the grant was INERT and every
 * test still passed — because every test handed it a username. The lesson is
 * pinned in `who the account is`: the identity comes from Oxy, through a call
 * this suite asserts is made.
 *
 * The rest are the silent, permissive ones:
 *
 *  - "the most expensive plan" is measured off the catalogue, not named. A
 *    hardcoded `ultra` passes every functional test on today's data and quietly
 *    stops being true the day a pricier plan is seeded;
 *  - idempotence. This runs on every release. A grant that rewrote the row each
 *    time would churn a billing table for nothing;
 *  - it must fail LOUDLY. `scripts/seed.ts` exits non-zero on a throw and that
 *    fails the deploy; a seeder that logs and returns is the shape that let
 *    production run with zero `plans` rows.
 */

const H = vi.hoisted(() => ({
  plans: [] as Array<Record<string, unknown>>,
  rows: new Map<string, Record<string, unknown>>(),
  upserts: [] as Array<Record<string, unknown>>,
  /** Usernames `getProfileByUsername` was asked for, in order. */
  lookups: [] as string[],
  /** Transactions written, and the dedup keys already taken. */
  transactions: [] as Array<Record<string, unknown>>,
  takenDedupKeys: new Set<string>(),
  creditsAdded: [] as Array<{ userId: string; amount: number; type: string }>,
  profile: async (username: string) => ({ id: `oxy-id-of-${username}` }),
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/billing/subscriptionRepository.js', () => ({
  findSubscriptionByStripeId: vi.fn(async (_db: unknown, id: string) => H.rows.get(id) ?? null),
  upsertSubscriptionByStripeId: vi.fn(async (_db: unknown, values: Record<string, unknown>) => {
    H.upserts.push(values);
    H.rows.set(values.stripeSubscriptionId as string, values);
    return values;
  }),
}));

vi.mock('../gateway-client.js', () => ({ getPlans: vi.fn(async () => H.plans) }));

/**
 * The credit half, mocked at the same seam as the subscription half.
 *
 * `insertTransaction` refuses a dedup key it has already seen, because that
 * unique index IS the double-credit guard — a mock that accepted every insert
 * would make the idempotence cases below pass while measuring nothing.
 */
vi.mock('../../db/billing/transactionRepository.js', () => ({
  insertTransaction: vi.fn(async (_db: unknown, values: Record<string, unknown>) => {
    const dedup = (values.metadata as { dedup?: string } | undefined)?.dedup;
    if (dedup !== undefined && H.takenDedupKeys.has(dedup)) {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        isDuplicate: true,
      });
    }
    if (dedup !== undefined) H.takenDedupKeys.add(dedup);
    H.transactions.push(values);
    return values;
  }),
  isDuplicateTransaction: vi.fn(
    (error: unknown) => (error as { isDuplicate?: boolean } | null)?.isDuplicate === true,
  ),
}));

vi.mock('../user-credits-helpers.js', () => ({ getOrCreateUserCredits: vi.fn(async () => ({})) }));

vi.mock('../../db/billing/userCreditsRepository.js', () => ({
  addCredits: vi.fn(async (_db: unknown, userId: string, amount: number, type: string) => {
    H.creditsAdded.push({ userId, amount, type });
    return {};
  }),
}));

vi.mock('../logger.js', () => ({
  log: { seed: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('@oxyhq/core', () => ({
  OxyServices: class {
    async getProfileByUsername(username: string) {
      H.lookups.push(username);
      return H.profile(username);
    }
  },
}));

import { isCompedSubscriptionId, seedCompedAccounts } from '../seed-comped-accounts.js';

/** A catalogue row shaped like the one `getPlans` really returns. */
const plan = (
  planId: string,
  product: 'alia' | 'codea',
  monthlyPrice: number,
  extra: Record<string, unknown> = {},
) => ({
  planId,
  name: planId,
  product,
  monthlyPrice,
  annualPrice: monthlyPrice * 10,
  creditsPerMonth: monthlyPrice,
  currency: 'usd',
  isActive: true,
  isFree: false,
  ...extra,
});

const OXY_ID = 'oxy-id-of-oxy';

beforeEach(() => {
  H.plans = [
    plan('free', 'alia', 0, { isFree: true }),
    plan('go', 'alia', 399),
    plan('pro', 'alia', 999),
    plan('ultra', 'alia', 9999),
    plan('max', 'alia', 4999),
    plan('codea-pro', 'codea', 999),
    plan('codea-max', 'codea', 4999),
  ];
  H.rows = new Map();
  H.upserts = [];
  H.lookups = [];
  H.transactions = [];
  H.takenDedupKeys = new Set();
  H.creditsAdded = [];
  H.profile = async (username: string) => ({ id: `oxy-id-of-${username}` });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('who the account is', () => {
  it('resolves the comped username through Oxy, because a request never carries one', async () => {
    // The regression this file is named for: `req.user` is `{ id }` and nothing
    // else, so a grant keyed on a username read off a request grants nobody.
    await seedCompedAccounts();
    expect(H.lookups).toEqual(['oxy']);
    expect(H.upserts.every((u) => u.oxyUserId === OXY_ID)).toBe(true);
  });

  it('fails the deploy when the username cannot be resolved', async () => {
    H.profile = async () => {
      throw new Error('oxy api unreachable');
    };
    await expect(seedCompedAccounts()).rejects.toThrow('oxy api unreachable');
    expect(H.upserts).toEqual([]);
  });

  it('fails the deploy when the account resolves to no id', async () => {
    H.profile = async () => ({ id: '' });
    await expect(seedCompedAccounts()).rejects.toThrow(/resolved to no id/);
  });
});

describe('which plan', () => {
  it('picks the dearest active paid plan of each product', async () => {
    const result = await seedCompedAccounts();
    expect(H.upserts.map((u) => u.planId).sort()).toEqual(['codea-max', 'ultra']);
    expect(H.upserts.map((u) => u.status)).toEqual(['active', 'active']);
    expect(result).toEqual({ granted: 2, unchanged: 0, credited: 2 });
  });

  it('follows the catalogue rather than a hardcoded id', async () => {
    // The mutation this case exists to survive: a pricier plan appears and the
    // grant moves to it with no code change. A hardcoded `ultra` passes every
    // other assertion here and fails this one.
    H.plans.push(plan('hyper', 'alia', 19999));
    await seedCompedAccounts();
    expect(H.upserts.map((u) => u.planId).sort()).toEqual(['codea-max', 'hyper']);
  });

  it('never picks a free or an inactive plan, however dear', async () => {
    H.plans = [
      plan('free', 'alia', 0, { isFree: true }),
      plan('legacy-enterprise', 'alia', 99999, { isActive: false }),
      plan('pro', 'alia', 999),
    ];
    await seedCompedAccounts();
    expect(H.upserts.map((u) => u.planId)).toEqual(['pro']);
  });

  it('breaks a price tie the same way whatever the catalogue order', async () => {
    const tied = [plan('b-plan', 'alia', 999), plan('a-plan', 'alia', 999)];
    H.plans = tied;
    await seedCompedAccounts();
    H.plans = [...tied].reverse();
    H.rows = new Map();
    await seedCompedAccounts();
    expect(H.upserts.map((u) => u.planId)).toEqual(['a-plan', 'a-plan']);
  });

  it('fails the deploy on a catalogue with nothing to grant', async () => {
    // Ordered after `plans` in `scripts/seed.ts`. If that order is ever broken,
    // this is what says so — instead of comping nobody and exiting 0.
    H.plans = [plan('free', 'alia', 0, { isFree: true })];
    await expect(seedCompedAccounts()).rejects.toThrow(/no active paid plan/);
    expect(H.lookups).toEqual([]);
  });
});

describe('the row it writes', () => {
  it('is a comp: prefixed ids, no price, no cancellation', async () => {
    await seedCompedAccounts();
    const alia = H.upserts.find((u) => u.planSnapshotProduct === 'alia');

    expect(alia).toBeDefined();
    expect(alia?.stripeSubscriptionId).toBe(`comp_${OXY_ID}_alia`);
    expect(isCompedSubscriptionId(alia?.stripeSubscriptionId as string)).toBe(true);
    expect(alia?.cancelAtPeriodEnd).toBe(false);
    // The snapshot is what was AGREED TO PAY, and a comp agreed to nothing.
    expect(alia?.planSnapshotPrice).toBe(0);
    expect(alia?.planSnapshotPlanId).toBe('ultra');
    expect(alia?.planSnapshotCreditsPerMonth).toBe(9999);
  });

  it('carries the current UTC month as its period', async () => {
    await seedCompedAccounts();
    const { currentPeriodStart, currentPeriodEnd } = H.upserts[0] as {
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
    };
    // A period frozen in the past is how the voice-minutes allowance silently
    // becomes zero: it is measured from `current_period_start`.
    expect(currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    expect(currentPeriodStart.getTime()).toBeLessThanOrEqual(Date.now());
    expect(currentPeriodStart.getUTCDate()).toBe(1);
    expect(currentPeriodEnd.getUTCDate()).toBe(1);
  });

  it('refuses a Stripe id as a comped one', () => {
    expect(isCompedSubscriptionId('sub_1PxyzABC')).toBe(false);
  });
});

describe('running it again', () => {
  it('writes nothing when the grant is already in place', async () => {
    await seedCompedAccounts();
    H.upserts = [];
    expect(await seedCompedAccounts()).toEqual({ granted: 0, unchanged: 2, credited: 0 });
    expect(H.upserts).toEqual([]);
  });

  it('re-grants when the stored row stops matching', async () => {
    await seedCompedAccounts();
    // Someone cancelled it, or the catalogue moved. Either way the next release
    // puts it back — this is what says a cancellation cannot stick.
    const id = `comp_${OXY_ID}_alia`;
    H.rows.set(id, { ...H.rows.get(id), cancelAtPeriodEnd: true });
    H.upserts = [];
    expect(await seedCompedAccounts()).toEqual({ granted: 1, unchanged: 1, credited: 0 });
    expect(H.upserts.map((u) => u.stripeSubscriptionId)).toEqual([id]);
  });
});

describe('the credits that come with the plan', () => {
  it("credits the plan's monthly credits, as a zero-amount subscription record", async () => {
    // The symptom this fixes: the account held Ultra and had 292 credits — the
    // daily free floor — because a comp has no invoice and nothing else credits.
    await seedCompedAccounts();

    expect(H.creditsAdded).toEqual([
      { userId: OXY_ID, amount: 9999, type: 'paid' },
      { userId: OXY_ID, amount: 4999, type: 'paid' },
    ]);
    // A zero amount, because no money moved: nothing that sums the column may
    // count revenue that does not exist.
    expect(H.transactions.map((t) => t.amount)).toEqual([0, 0]);
    expect(H.transactions.map((t) => t.credits)).toEqual([9999, 4999]);
  });

  it('keys the lock on the subscription and the period, like a Stripe renewal', async () => {
    await seedCompedAccounts();
    const dedup = H.transactions.map((t) => (t.metadata as { dedup: string }).dedup);

    expect(dedup[0]).toContain(`comp_${OXY_ID}_alia`);
    // The period, so a new month is a new key and credits again.
    expect(dedup[0]).toMatch(/_\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect(new Set(dedup).size).toBe(2);
  });

  it('credits once, however many times the release runs', async () => {
    await seedCompedAccounts();
    H.creditsAdded = [];
    expect((await seedCompedAccounts()).credited).toBe(0);
    expect(H.creditsAdded).toEqual([]);
  });

  it('credits an account whose subscription row already matches', async () => {
    // The ordering this case exists to pin. On the first release after the
    // grant existed the row was ALREADY correct and the credits had never been
    // granted, so crediting only on a row CHANGE would have left exactly the
    // account this is for on the free floor.
    await seedCompedAccounts();
    H.creditsAdded = [];
    H.takenDedupKeys = new Set();
    const result = await seedCompedAccounts();

    expect(result.unchanged).toBe(2);
    expect(result.granted).toBe(0);
    expect(result.credited).toBe(2);
  });

  it('credits nothing for a plan that includes none', async () => {
    H.plans = [plan('bare', 'alia', 999, { creditsPerMonth: 0 })];
    await seedCompedAccounts();
    expect(H.creditsAdded).toEqual([]);
    // The floor: the plan was still granted, so this is not "nothing happened".
    expect(H.upserts.map((u) => u.planId)).toEqual(['bare']);
  });
});
