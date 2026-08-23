import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The comp grant — a named Oxy account holds the most expensive plan of every
 * product without paying for it.
 *
 * Every failure this file is built around is SILENT and permissive or silent
 * and useless, which is why each one is asserted against the real module rather
 * than against a description of it:
 *
 *  - the username gate. Widen it by one character and every account in the
 *    system is granted the top plan for free. So the negative case is asserted
 *    on the DATABASE, not on a return value: a non-comped user must not reach a
 *    write at all;
 *  - "the most expensive plan". It is measured off the catalogue, not named, so
 *    a pricier plan seeded tomorrow is the one granted. A hardcoded `ultra`
 *    would pass every functional test on today's data and quietly stop being
 *    true;
 *  - idempotence. This runs on the auth path. A grant that rewrote the row on
 *    every call would invalidate the entitlement cache on every request, which
 *    is a five-minute cache doing no work at all;
 *  - the swallow. It must never fail a request, and a `throw` from the database
 *    is the likeliest way it would.
 */

const H = vi.hoisted(() => ({
  plans: [] as Array<Record<string, unknown>>,
  rows: new Map<string, Record<string, unknown>>(),
  upserts: [] as Array<Record<string, unknown>>,
  invalidated: [] as string[],
  findThrows: false,
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/billing/subscriptionRepository.js', () => ({
  findSubscriptionByStripeId: vi.fn(async (_db: unknown, id: string) => {
    if (H.findThrows) throw new Error('connection terminated');
    return H.rows.get(id) ?? null;
  }),
  upsertSubscriptionByStripeId: vi.fn(async (_db: unknown, values: Record<string, unknown>) => {
    H.upserts.push(values);
    H.rows.set(values.stripeSubscriptionId as string, values);
    return values;
  }),
}));

vi.mock('../gateway-client.js', () => ({ getPlans: vi.fn(async () => H.plans) }));

vi.mock('../plan-access.js', () => ({
  invalidateEntitlementsCache: vi.fn((userId: string) => {
    H.invalidated.push(userId);
  }),
}));

vi.mock('../logger.js', () => ({
  log: { credits: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  COMPED_USERNAMES,
  ensureCompedSubscriptions,
  isCompedSubscriptionId,
} from '../comped-accounts.js';

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

/** A fresh account per assertion: the "already ensured" cache is module-level. */
let seq = 0;
const account = (): string => `user-comp-${(seq += 1)}`;

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
  H.invalidated = [];
  H.findThrows = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('who is comped', () => {
  it('grants the comped username, and writes nothing for anybody else', async () => {
    const granted = account();
    await ensureCompedSubscriptions({ id: granted, username: 'oxy' });
    expect(H.upserts.length).toBe(2);

    // The half that matters. Asserted on the write, not on a returned value:
    // both calls return `undefined`, so a gate that had stopped gating would
    // look identical from the outside.
    H.upserts = [];
    for (const username of ['oxyy', 'oxy-labs', 'notoxy', 'alia', '']) {
      await ensureCompedSubscriptions({ id: account(), username });
    }
    await ensureCompedSubscriptions({ id: account() });
    await ensureCompedSubscriptions(null);
    expect(H.upserts).toEqual([]);
  });

  it('is not defeated by a capital letter', async () => {
    await ensureCompedSubscriptions({ id: account(), username: 'Oxy' });
    expect(H.upserts.length).toBe(2);
  });

  it('names the account the product is about', () => {
    expect([...COMPED_USERNAMES]).toEqual(['oxy']);
  });
});

describe('which plan', () => {
  it('picks the dearest active paid plan of each product', async () => {
    const userId = account();
    await ensureCompedSubscriptions({ id: userId, username: 'oxy' });

    expect(H.upserts.map((u) => u.planId).sort()).toEqual(['codea-max', 'ultra']);
    expect(H.upserts.map((u) => u.status)).toEqual(['active', 'active']);
    expect(H.invalidated).toEqual([userId]);
  });

  it('follows the catalogue rather than a hardcoded id', async () => {
    // The mutation this file exists to survive: a pricier plan appears, and the
    // grant must move to it with no code change. A hardcoded `ultra` passes
    // every other assertion here and fails this one.
    H.plans.push(plan('hyper', 'alia', 19999));
    await ensureCompedSubscriptions({ id: account(), username: 'oxy' });
    expect(H.upserts.map((u) => u.planId).sort()).toEqual(['codea-max', 'hyper']);
  });

  it('never picks a free or an inactive plan, however dear', async () => {
    H.plans = [
      plan('free', 'alia', 0, { isFree: true }),
      plan('legacy-enterprise', 'alia', 99999, { isActive: false }),
      plan('pro', 'alia', 999),
    ];
    await ensureCompedSubscriptions({ id: account(), username: 'oxy' });
    expect(H.upserts.map((u) => u.planId)).toEqual(['pro']);
  });

  it('breaks a price tie the same way whatever the catalogue order', async () => {
    // Otherwise the grant flips between two equal plans from one call to the
    // next, rewriting the row and dropping the entitlement cache every time.
    const tied = [plan('b-plan', 'alia', 999), plan('a-plan', 'alia', 999)];
    H.plans = tied;
    await ensureCompedSubscriptions({ id: account(), username: 'oxy' });
    H.plans = [...tied].reverse();
    await ensureCompedSubscriptions({ id: account(), username: 'oxy' });
    expect(H.upserts.map((u) => u.planId)).toEqual(['a-plan', 'a-plan']);
  });
});

describe('the row it writes', () => {
  it('is a comp: prefixed ids, no price, no cancellation', async () => {
    const userId = account();
    await ensureCompedSubscriptions({ id: userId, username: 'oxy' });
    const alia = H.upserts.find((u) => u.planSnapshotProduct === 'alia');

    expect(alia).toBeDefined();
    expect(alia?.stripeSubscriptionId).toBe(`comp_${userId}_alia`);
    expect(isCompedSubscriptionId(alia?.stripeSubscriptionId as string)).toBe(true);
    expect(alia?.oxyUserId).toBe(userId);
    expect(alia?.cancelAtPeriodEnd).toBe(false);
    // The snapshot is what was AGREED TO PAY, and a comp agreed to nothing.
    expect(alia?.planSnapshotPrice).toBe(0);
    expect(alia?.planSnapshotPlanId).toBe('ultra');
    expect(alia?.planSnapshotCreditsPerMonth).toBe(9999);
  });

  it('carries a period that ends in the future and starts a month before', async () => {
    await ensureCompedSubscriptions({ id: account(), username: 'oxy' });
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

describe('cost on the request path', () => {
  it('writes once for an account that already holds the grant', async () => {
    const userId = account();
    await ensureCompedSubscriptions({ id: userId, username: 'oxy' });
    expect(H.upserts.length).toBe(2);
    expect(H.invalidated).toEqual([userId]);

    // A second process, or this one past the ensure cache: the rows are there,
    // so nothing is rewritten and the entitlement cache is left alone.
    H.upserts = [];
    H.invalidated = [];
    vi.resetModules();
    const fresh = await import('../comped-accounts.js');
    await fresh.ensureCompedSubscriptions({ id: userId, username: 'oxy' });
    expect(H.upserts).toEqual([]);
    expect(H.invalidated).toEqual([]);
  });

  it('re-grants when the stored row stops matching', async () => {
    const userId = account();
    await ensureCompedSubscriptions({ id: userId, username: 'oxy' });

    // Someone cancelled it, or the catalogue moved. Either way the next ensure
    // has to put it back — this is the assertion that a cancel cannot stick.
    const id = `comp_${userId}_alia`;
    H.rows.set(id, { ...H.rows.get(id), cancelAtPeriodEnd: true });
    H.upserts = [];
    H.invalidated = [];
    vi.resetModules();
    const fresh = await import('../comped-accounts.js');
    await fresh.ensureCompedSubscriptions({ id: userId, username: 'oxy' });
    expect(H.upserts.map((u) => u.stripeSubscriptionId)).toEqual([id]);
    expect(H.invalidated).toEqual([userId]);
  });
});

describe('it cannot fail a request', () => {
  it('swallows a database failure', async () => {
    H.findThrows = true;
    await expect(ensureCompedSubscriptions({ id: account(), username: 'oxy' })).resolves.toBeUndefined();
    expect(H.upserts).toEqual([]);
  });

  it('does not mark a failed account as ensured', async () => {
    // Otherwise one bad minute costs the account its plan until the process
    // restarts — the cache would remember a grant that never happened.
    const userId = account();
    H.findThrows = true;
    await ensureCompedSubscriptions({ id: userId, username: 'oxy' });
    H.findThrows = false;
    await ensureCompedSubscriptions({ id: userId, username: 'oxy' });
    expect(H.upserts.length).toBe(2);
  });
});
