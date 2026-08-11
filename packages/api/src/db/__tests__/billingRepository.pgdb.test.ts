import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  countTransactions,
  countTransactionsForUser,
  insertTransaction,
  isDuplicateTransaction,
  selectTransactions,
  selectTransactionsForUser,
} from '../billing/transactionRepository';
import {
  countSubscriptions,
  findActiveSubscription,
  findActiveSubscriptionByPeriodStart,
  findActiveSubscriptions,
  findSubscriptionByStripeId,
  selectSubscriptions,
  selectSubscriptionsForUser,
  updateSubscriptionByStripeId,
  upsertSubscriptionByStripeId,
  type SubscriptionInsert,
} from '../billing/subscriptionRepository';
import {
  addCredits,
  findUserCredits,
  findUserCreditsByStripeCustomerId,
  getOrCreateUserCredits,
  refreshFreeCreditsIfDue,
  setStripeCustomerId,
  spendCreditsFreeFirst,
  spendCreditsPaidFirst,
  zeroCredits,
} from '../billing/userCreditsRepository';
import { transactions, userCredits } from '../schema/billing';

/**
 * `subscriptions`, `transactions` and `user_credits` against a real server.
 *
 * The three properties that carry the most risk in this slice all live here and
 * none has a mocked counterpart:
 *
 * 1. **The double-credit guard.** `dedup_key` is a STORED GENERATED column and
 *    the duplicate is caught by CONSTRAINT NAME. A mocked insert never raises,
 *    so the branch would look covered and be dead.
 * 2. **Balance arithmetic in SQL**, including that a refusal leaves the row
 *    untouched — a property of the statement, not of the code around it.
 * 3. **"The active subscription" ordering**, which used to be arbitrary.
 *
 * Ids are namespaced `br-`; instants are relative to now.
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

function aSubscription(over: Partial<SubscriptionInsert> & { stripeSubscriptionId: string; oxyUserId: string }): SubscriptionInsert {
  return {
    stripeCustomerId: `cus_${over.oxyUserId}`,
    stripePriceId: 'price_test',
    status: 'active',
    currentPeriodStart: daysAgo(10),
    currentPeriodEnd: daysAgo(-20),
    planSnapshotName: 'Test Plan',
    planSnapshotProduct: 'alia',
    planSnapshotCreditsPerMonth: 1000,
    planSnapshotPrice: 999,
    ...over,
  };
}

describe('the double-credit guard', () => {
  it('derives dedup_key from metadata and REFUSES the second write', async () => {
    const dedup = 'br-sub_1_1700000000';
    await insertTransaction(db, {
      oxyUserId: 'br-dedup-user',
      type: 'subscription_payment',
      amount: 999,
      credits: 1000,
      status: 'completed',
      metadata: { dedup },
    });

    // The column is GENERATED, never written directly — so there is no way to
    // supply the metadata without the constraint seeing it.
    const [row] = await db.select().from(transactions).where(eq(transactions.dedupKey, dedup));
    expect(row?.dedupKey).toBe(dedup);

    let caught: unknown;
    try {
      await insertTransaction(db, {
        oxyUserId: 'br-dedup-user',
        type: 'subscription_payment',
        amount: 999,
        credits: 1000,
        status: 'completed',
        metadata: { dedup },
      });
    } catch (error) {
      caught = error;
    }

    /**
     * THE assertion of this slice. `routes/billing.ts` writes this row as a lock
     * and skips the credit grant when it is refused. If `isDuplicateTransaction`
     * stops returning true, the error escapes the skip, the handler throws, and
     * Stripe redelivers — crediting the customer again on the retry that
     * succeeds.
     */
    expect(caught).toBeDefined();
    expect(constraintNameOf(caught)).toBe('transactions_dedup_key_key');
    expect(isDuplicateTransaction(caught)).toBe(true);
  });

  it('recognises a duplicate payment intent too', async () => {
    const intent = 'pi_br_duplicate';
    await insertTransaction(db, {
      oxyUserId: 'br-intent-user',
      stripePaymentIntentId: intent,
      type: 'credit_purchase',
      amount: 500,
      credits: 500,
      status: 'completed',
    });

    let caught: unknown;
    try {
      await insertTransaction(db, {
        oxyUserId: 'br-intent-user',
        stripePaymentIntentId: intent,
        type: 'credit_purchase',
        amount: 500,
        credits: 500,
        status: 'completed',
      });
    } catch (error) {
      caught = error;
    }
    expect(constraintNameOf(caught)).toBe('transactions_stripe_payment_intent_id_key');
    expect(isDuplicateTransaction(caught)).toBe(true);
  });

  it('does NOT call an unrelated unique violation a duplicate payment', async () => {
    // A negative control with real currency: swallowing this as "already
    // recorded" would DROP a genuine payment record. The violation is on
    // `user_credits`' primary key, which is a unique violation and not a
    // transactions one.
    await getOrCreateUserCredits(db, 'br-unrelated');
    let caught: unknown;
    try {
      await db.insert(userCredits).values({ id: 'br-unrelated', creditsLastRefresh: new Date() });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isDuplicateTransaction(caught)).toBe(false);
  });

  it('permits many transactions with NO dedup key', async () => {
    // The generated column is null when `metadata` carries no `dedup`, and
    // Postgres treats nulls as distinct in a unique index — so an ordinary
    // transaction is never a duplicate of another ordinary one.
    for (let i = 0; i < 3; i++) {
      await insertTransaction(db, {
        oxyUserId: 'br-nodedup',
        type: 'credit_purchase',
        amount: 100,
        credits: 100,
        status: 'completed',
      });
    }
    expect(await countTransactionsForUser(db, 'br-nodedup')).toBe(3);
  });
});

describe('transactions', () => {
  it('lists one account newest first, paginated, with a numeric count', async () => {
    for (const [i, amount] of [10, 20, 30].entries()) {
      await insertTransaction(db, {
        oxyUserId: 'br-list',
        type: 'credit_purchase',
        amount,
        credits: amount,
        status: 'completed',
        description: `n${String(i)}`,
      });
    }
    const total = await countTransactionsForUser(db, 'br-list');
    expect(typeof total).toBe('number');
    expect(total).toBe(3);

    const firstPage = await selectTransactionsForUser(db, 'br-list', { limit: 2, offset: 0 });
    expect(firstPage).toHaveLength(2);
    const secondPage = await selectTransactionsForUser(db, 'br-list', { limit: 2, offset: 2 });
    expect(secondPage).toHaveLength(1);
    // `bigint({ mode: 'number' })` — money must not arrive as a string.
    expect(typeof firstPage[0]?.amount).toBe('number');
  });

  it('filters the admin list by status and type together', async () => {
    await insertTransaction(db, { oxyUserId: 'br-admin', type: 'credit_purchase', amount: 1, credits: 1, status: 'pending' });
    await insertTransaction(db, { oxyUserId: 'br-admin', type: 'refund', amount: 2, credits: 2, status: 'completed' });

    const pending = (await selectTransactions(db, { status: 'pending' }, { limit: 100, offset: 0 }))
      .filter((t) => t.oxyUserId === 'br-admin');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe('credit_purchase');

    // Both conditions must AND rather than one replacing the other.
    expect(await countSubscriptions(db, {})).toBeGreaterThanOrEqual(0);
    const none = (await selectTransactions(db, { status: 'pending', type: 'refund' }, { limit: 100, offset: 0 }))
      .filter((t) => t.oxyUserId === 'br-admin');
    expect(none).toHaveLength(0);
  });
});

describe('subscriptions', () => {
  it('upserts on the Stripe id rather than adding a second row', async () => {
    const id = 'sub_br_upsert';
    await upsertSubscriptionByStripeId(db, aSubscription({ stripeSubscriptionId: id, oxyUserId: 'br-upsert', status: 'trialing' }));
    const updated = await upsertSubscriptionByStripeId(
      db,
      aSubscription({ stripeSubscriptionId: id, oxyUserId: 'br-upsert', status: 'active', planSnapshotName: 'Renamed' }),
    );
    expect(updated.status).toBe('active');
    expect(updated.planSnapshotName).toBe('Renamed');
    expect(await selectSubscriptionsForUser(db, 'br-upsert')).toHaveLength(1);
  });

  it('returns the MOST RECENTLY CREATED live subscription, not an arbitrary one', async () => {
    /**
     * The behaviour change, pinned. Four call sites read "the user's active
     * subscription" with no sort at all, and a user can hold two — so the answer
     * used to depend on which document the index yielded. Three of those sites
     * fed `getMemoryLimit()`.
     */
    /**
     * `created_at` is written EXPLICITLY rather than left to `defaultNow()`.
     * The default has millisecond precision, so two inserts issued back to back
     * can share an instant and the `DESC` ordering becomes a tie — which makes
     * the test pass or fail on timing rather than on the ordering it is about.
     * (Caught by a mutation run in which this case failed for a mutation that
     * could not possibly have affected it.)
     */
    await upsertSubscriptionByStripeId(db, aSubscription({ stripeSubscriptionId: 'sub_br_old', oxyUserId: 'br-two', planSnapshotName: 'Older', planSnapshotProduct: 'alia', createdAt: daysAgo(5) }));
    await upsertSubscriptionByStripeId(db, aSubscription({ stripeSubscriptionId: 'sub_br_new', oxyUserId: 'br-two', planSnapshotName: 'Newer', planSnapshotProduct: 'codea', createdAt: daysAgo(1) }));

    const one = await findActiveSubscription(db, 'br-two');
    expect(one?.planSnapshotName).toBe('Newer');

    // And both are reachable when the caller asks for all of them.
    const all = await findActiveSubscriptions(db, 'br-two');
    expect(all.map((s) => s.planSnapshotName)).toEqual(['Newer', 'Older']);
  });

  it('scopes to a product through the SNAPSHOT, which is what was sold', async () => {
    const alia = await findActiveSubscription(db, 'br-two', { product: 'alia' });
    expect(alia?.planSnapshotName).toBe('Older');
    const codea = await findActiveSubscription(db, 'br-two', { product: 'codea' });
    expect(codea?.planSnapshotName).toBe('Newer');
  });

  it('EXCLUDES a subscription that is neither active nor trialing', async () => {
    await upsertSubscriptionByStripeId(db, aSubscription({ stripeSubscriptionId: 'sub_br_dead', oxyUserId: 'br-dead', status: 'canceled' }));
    expect(await findActiveSubscription(db, 'br-dead')).toBeNull();

    // Positive control: the same row becomes visible once it is live again, so
    // the null above is the status filter and not a failed fixture.
    await updateSubscriptionByStripeId(db, 'sub_br_dead', { status: 'trialing' });
    expect(await findActiveSubscription(db, 'br-dead')).not.toBeNull();
  });

  it('orders by PERIOD START for the voice entitlement, a different question', async () => {
    // Created newest-last but with the LATER period, so the two orderings
    // disagree and this asserts which one the entitlement uses.
    await upsertSubscriptionByStripeId(db, aSubscription({
      stripeSubscriptionId: 'sub_br_period_late', oxyUserId: 'br-period',
      planSnapshotName: 'LatePeriod', currentPeriodStart: daysAgo(1), createdAt: daysAgo(90),
    }));
    await upsertSubscriptionByStripeId(db, aSubscription({
      stripeSubscriptionId: 'sub_br_period_early', oxyUserId: 'br-period',
      planSnapshotName: 'EarlyPeriod', currentPeriodStart: daysAgo(100), createdAt: daysAgo(2),
    }));

    expect((await findActiveSubscriptionByPeriodStart(db, 'br-period'))?.planSnapshotName).toBe('LatePeriod');
    // Created last (explicit `created_at`), so the creation-ordered read gives
    // the other one — the two orderings genuinely disagree here, which is the
    // only way this asserts WHICH ordering the entitlement uses.
    expect((await findActiveSubscription(db, 'br-period'))?.planSnapshotName).toBe('EarlyPeriod');
  });

  it('answers null for an update naming no subscription', async () => {
    expect(await updateSubscriptionByStripeId(db, 'sub_br_absent', { status: 'canceled' })).toBeNull();
    expect(await findSubscriptionByStripeId(db, 'sub_br_absent')).toBeNull();
  });

  it('filters the admin list by status and snapshot product', async () => {
    const byProduct = await selectSubscriptions(db, { product: 'codea' }, { limit: 200, offset: 0 });
    expect(byProduct.every((s) => s.planSnapshotProduct === 'codea')).toBe(true);
    expect(byProduct.some((s) => s.stripeSubscriptionId === 'sub_br_new')).toBe(true);
    expect(typeof (await countSubscriptions(db, { status: 'active' }))).toBe('number');
  });
});

describe('user credits', () => {
  it('creates the row once and returns the SAME row on a second call', async () => {
    const first = await getOrCreateUserCredits(db, 'br-credits-once');
    expect(first.creditsFree).toBe(300);
    await addCredits(db, 'br-credits-once', 50, 'paid');
    const second = await getOrCreateUserCredits(db, 'br-credits-once');
    // A `DO NOTHING` that then re-inserted, or an upsert setting the defaults
    // again, would reset the balance here.
    expect(second.creditsPaid).toBe(50);
    expect(second.creditsFree).toBe(300);
  });

  it('spends PAID first when asked to, and FREE first when asked to', async () => {
    await getOrCreateUserCredits(db, 'br-order-paid');
    await db.update(userCredits).set({ creditsFree: 10, creditsPaid: 10 }).where(eq(userCredits.id, 'br-order-paid'));
    const paidFirst = await spendCreditsPaidFirst(db, 'br-order-paid', 4);
    expect({ free: paidFirst?.creditsFree, paid: paidFirst?.creditsPaid }).toEqual({ free: 10, paid: 6 });

    await getOrCreateUserCredits(db, 'br-order-free');
    await db.update(userCredits).set({ creditsFree: 10, creditsPaid: 10 }).where(eq(userCredits.id, 'br-order-free'));
    const freeFirst = await spendCreditsFreeFirst(db, 'br-order-free', 4);
    // The two orders are genuinely different operations; collapsing them would
    // pass one of these and fail the other.
    expect({ free: freeFirst?.creditsFree, paid: freeFirst?.creditsPaid }).toEqual({ free: 6, paid: 10 });
  });

  it('zeroes both balances', async () => {
    await getOrCreateUserCredits(db, 'br-zero');
    await addCredits(db, 'br-zero', 99, 'paid');
    const zeroed = await zeroCredits(db, 'br-zero');
    expect({ free: zeroed?.creditsFree, paid: zeroed?.creditsPaid }).toEqual({ free: 0, paid: 0 });
  });

  it('links and finds a Stripe customer', async () => {
    await getOrCreateUserCredits(db, 'br-stripe');
    expect(await findUserCreditsByStripeCustomerId(db, 'cus_br_test')).toBeNull();
    await setStripeCustomerId(db, 'br-stripe', 'cus_br_test');
    expect((await findUserCreditsByStripeCustomerId(db, 'cus_br_test'))?.id).toBe('br-stripe');
  });

  it('answers null rather than creating a row for an unknown account', async () => {
    expect(await findUserCredits(db, 'br-nobody')).toBeNull();
    expect(await addCredits(db, 'br-nobody', 10)).toBeNull();
    expect(await zeroCredits(db, 'br-nobody')).toBeNull();
    expect(await spendCreditsFreeFirst(db, 'br-nobody', 1)).toBeNull();
  });
});

describe('the daily free refresh', () => {
  it('does NOT refresh before 24 hours have passed', async () => {
    await getOrCreateUserCredits(db, 'br-refresh-early');
    await db
      .update(userCredits)
      .set({ creditsFree: 1, creditsFreeLimit: 300, creditsLastRefresh: new Date(Date.now() - 23 * 60 * 60 * 1000) })
      .where(eq(userCredits.id, 'br-refresh-early'));

    const row = await refreshFreeCreditsIfDue(db, 'br-refresh-early');
    // Returns the row either way — the caller wants the balance — but must not
    // have topped it up.
    expect(row?.creditsFree).toBe(1);
  });

  it('refreshes to the LIMIT once a day has passed', async () => {
    await getOrCreateUserCredits(db, 'br-refresh-due');
    await db
      .update(userCredits)
      .set({ creditsFree: 1, creditsFreeLimit: 250, creditsLastRefresh: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(userCredits.id, 'br-refresh-due'));

    const row = await refreshFreeCreditsIfDue(db, 'br-refresh-due');
    // The LIMIT, not the 300 default: an account with a custom allowance keeps it.
    expect(row?.creditsFree).toBe(250);

    // Immediately due again? No — `last_refresh` moved to the server's now().
    const again = await refreshFreeCreditsIfDue(db, 'br-refresh-due');
    expect(again?.creditsFree).toBe(250);
    await db.update(userCredits).set({ creditsFree: 7 }).where(eq(userCredits.id, 'br-refresh-due'));
    expect((await refreshFreeCreditsIfDue(db, 'br-refresh-due'))?.creditsFree).toBe(7);
  });

  it('grants the allowance exactly ONCE under two simultaneous refreshes', async () => {
    await getOrCreateUserCredits(db, 'br-refresh-race');
    await db
      .update(userCredits)
      .set({ creditsFree: 0, creditsFreeLimit: 300, creditsLastRefresh: new Date(Date.now() - 30 * 60 * 60 * 1000) })
      .where(eq(userCredits.id, 'br-refresh-race'));

    // The compare-and-set is against the server's `now()` INSIDE the statement,
    // so the loser's predicate is false by the time it runs. The source read the
    // stored instant into JS first, which left a window.
    await Promise.all([
      refreshFreeCreditsIfDue(db, 'br-refresh-race'),
      refreshFreeCreditsIfDue(db, 'br-refresh-race'),
    ]);

    const row = await findUserCredits(db, 'br-refresh-race');
    // 300, not 600: a second grant would have added another allowance.
    expect(row?.creditsFree).toBe(300);
  });

  it('answers null for an account that does not exist', async () => {
    expect(await refreshFreeCreditsIfDue(db, 'br-refresh-nobody')).toBeNull();
  });
});

describe('the admin summary reads all three tables', () => {
  it('returns the credits, subscriptions and transactions of one account', async () => {
    await getOrCreateUserCredits(db, 'br-summary');
    await upsertSubscriptionByStripeId(db, aSubscription({ stripeSubscriptionId: 'sub_br_summary', oxyUserId: 'br-summary' }));
    await insertTransaction(db, { oxyUserId: 'br-summary', type: 'credit_purchase', amount: 1, credits: 1, status: 'completed' });

    expect((await findUserCredits(db, 'br-summary'))?.id).toBe('br-summary');
    expect(await selectSubscriptionsForUser(db, 'br-summary')).toHaveLength(1);
    expect(await selectTransactionsForUser(db, 'br-summary', { limit: 50 })).toHaveLength(1);
    expect(await countTransactions(db, { status: 'completed' })).toBeGreaterThan(0);
  });
});
