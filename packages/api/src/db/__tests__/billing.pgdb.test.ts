import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isForeignKeyViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { creditPackages, features, planFeatures, plans, subscriptions, transactions, userCredits } from '../schema/billing';

/**
 * The billing tables, against a REAL server.
 *
 * Everything asserted here is a property a mocked `insert` cannot have: a
 * generated column's expression, a unique index's arbiter, a foreign key's
 * cascade, a CHECK, and how the driver decodes `bigint`. A mock accepts every
 * statement, including the ones the server rejects outright.
 *
 * Driver errors go through `@oxyhq/db`'s predicates and the constraint is NAMED
 * — `isUniqueViolation` alone cannot tell the index under test from any other
 * index on the table.
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

/** A transaction row with every NOT NULL column filled, so a test names only what it is testing. */
function transactionValues(overrides: Partial<typeof transactions.$inferInsert> = {}) {
  return {
    oxyUserId: 'oxy-user-1',
    type: 'subscription_payment' as const,
    amount: 1000,
    credits: 500,
    status: 'completed' as const,
    ...overrides,
  };
}

describe('the dedup key is the double-credit guard, and it survived the port', () => {
  /**
   * `routes/billing.ts` writes a transaction FIRST as a lock, keyed
   * `<subscriptionId>_<periodStart>`, and reads the duplicate-key error as
   * "already credited, skip". In Mongo that was
   * `index({'metadata.dedup': 1}, {unique: true, sparse: true})` — a unique index
   * on a path inside a `Mixed` field, which a mechanical `metadata → jsonb` port
   * drops in silence. The symptom is a customer credited twice on a webhook
   * redelivery, with no error raised anywhere.
   */
  it('derives dedup_key from the metadata a caller actually writes', async () => {
    await db.insert(transactions).values(
      transactionValues({ id: 'txn-derive', metadata: { dedup: 'sub_123_1700000000', note: 'ignored' } }),
    );

    const [row] = await db
      .select({ dedupKey: transactions.dedupKey })
      .from(transactions)
      .where(eq(transactions.id, 'txn-derive'));

    // Not merely "the column exists": the generated expression names `metadata`
    // as a literal, so this is what catches it going stale.
    expect(row?.dedupKey).toBe('sub_123_1700000000');
  });

  it('refuses a second transaction carrying the same dedup key', async () => {
    await db.insert(transactions).values(
      transactionValues({ id: 'txn-lock-1', metadata: { dedup: 'sub_456_1700000000' } }),
    );

    const redelivery = db.insert(transactions).values(
      transactionValues({ id: 'txn-lock-2', metadata: { dedup: 'sub_456_1700000000' } }),
    );

    await expect(redelivery).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('transactions_dedup_key_key');
      return true;
    });
  });

  it('lets any number of transactions carry no dedup key at all', async () => {
    // A one-off credit purchase has no renewal to deduplicate. Mongo's `sparse`
    // exempted a MISSING field; a null `metadata->>'dedup'` is the equivalent,
    // and Postgres treats nulls as distinct in a unique index.
    await db.insert(transactions).values(transactionValues({ id: 'txn-nodedup-1', metadata: { note: 'a' } }));
    await db.insert(transactions).values(transactionValues({ id: 'txn-nodedup-2', metadata: { note: 'b' } }));
    await db.insert(transactions).values(transactionValues({ id: 'txn-nodedup-3', metadata: null }));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${transactions} where id like 'txn-nodedup-%'`,
    );
    expect(rows[0]?.n).toBe('3');
  });
});

describe('money is bigint, and bigint does not arrive as a number by itself', () => {
  it('hands a column back as a number, because mode: number says so', async () => {
    await db.insert(transactions).values(transactionValues({ id: 'txn-amount', amount: 4999 }));

    const [row] = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.id, 'txn-amount'));

    expect(typeof row?.amount).toBe('number');
    expect(row?.amount).toBe(4999);
  });

  it('needs an explicit coercion on an AGGREGATE, and one aggregation cannot show it', async () => {
    /**
     * postgres.js decodes `int8`/`numeric` as a STRING. drizzle escapes that for
     * a COLUMN via `mode: 'number'`, but an aggregate has no column builder to
     * carry the mode, so `sum()`/`max()` come back as strings while typing as
     * numbers — `max + 1` then concatenates.
     *
     * Two sequential appends, deliberately: with a single row, `max + 1` gives
     * the same answer under either behaviour, so a test that appends once passes
     * whether or not the coercion is there. The second append is what makes "7"
     * + "1" = "71" distinguishable from 8.
     */
    await db.insert(transactions).values(transactionValues({ id: 'txn-agg-1', amount: 7 }));

    const first = await db.execute<{ max: string | number }>(
      sql`select max(amount) as max from ${transactions} where id like 'txn-agg-%'`,
    );
    const nextAmount = Number(first[0]?.max) + 1;
    await db.insert(transactions).values(transactionValues({ id: 'txn-agg-2', amount: nextAmount }));

    const second = await db.execute<{ max: string | number }>(
      sql`select max(amount) as max from ${transactions} where id like 'txn-agg-%'`,
    );

    expect(nextAmount).toBe(8);
    expect(Number(second[0]?.max)).toBe(8);
    // Had the first read been used without `Number(...)`, this would be 71.
    expect(Number(second[0]?.max)).not.toBe(71);
  });
});

describe('a payment intent identifies at most one transaction', () => {
  it('refuses a second transaction for the same payment intent', async () => {
    await db.insert(transactions).values(
      transactionValues({ id: 'txn-pi-1', stripePaymentIntentId: 'pi_dup' }),
    );

    const second = db.insert(transactions).values(
      transactionValues({ id: 'txn-pi-2', stripePaymentIntentId: 'pi_dup' }),
    );

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('transactions_stripe_payment_intent_id_key');
      return true;
    });
  });

  it('permits many transactions with no payment intent', async () => {
    // Mongo's `sparse: true` did NOT exempt a stored `null` — a second explicit
    // null was an E11000 there. Postgres nulls are distinct, so this is strictly
    // more permissive than the source, and correct.
    await db.insert(transactions).values(transactionValues({ id: 'txn-pi-null-1' }));
    await db.insert(transactions).values(transactionValues({ id: 'txn-pi-null-2' }));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${transactions} where id like 'txn-pi-null-%'`,
    );
    expect(rows[0]?.n).toBe('2');
  });
});

describe('the catalogue junction is a real relation', () => {
  beforeAll(async () => {
    await db.insert(plans).values({ id: 'plan-row', planId: 'pro', name: 'Pro', product: 'alia' });
    await db.insert(features).values({
      id: 'feature-row',
      featureId: 'priority-support',
      label: 'Priority support',
      category: 'support',
    });
  });

  it('refuses a mapping naming a plan that does not exist', async () => {
    const orphan = db.insert(planFeatures).values({
      id: 'pf-orphan',
      planId: 'no-such-plan',
      featureId: 'priority-support',
    });

    await expect(orphan).rejects.toSatisfy((error: unknown) => {
      expect(isForeignKeyViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('plan_features_plan_id_fk');
      return true;
    });
  });

  it('refuses two mappings of the same plan to the same feature', async () => {
    await db.insert(planFeatures).values({ id: 'pf-1', planId: 'pro', featureId: 'priority-support' });

    const duplicate = db.insert(planFeatures).values({
      id: 'pf-2',
      planId: 'pro',
      featureId: 'priority-support',
    });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('plan_features_plan_feature_key');
      return true;
    });
  });

  it('takes the mappings with the plan, so a re-created plan inherits nothing', async () => {
    await db.insert(plans).values({ id: 'plan-doomed', planId: 'doomed', name: 'Doomed', product: 'alia' });
    await db
      .insert(planFeatures)
      .values({ id: 'pf-doomed', planId: 'doomed', featureId: 'priority-support' });

    await db.delete(plans).where(eq(plans.planId, 'doomed'));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${planFeatures} where plan_id = 'doomed'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('closed value sets that ARE this service\'s own are enforced', () => {
  it('refuses a transaction type outside the tuple', async () => {
    const insert = db.execute(sql`
      insert into ${transactions} (id, oxy_user_id, type, amount, credits)
      values ('txn-badtype', 'oxy-user-1', 'chargeback', 100, 0)
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('transactions_type_check');
      return true;
    });
  });

  it('accepts any subscription status, because Stripe owns that vocabulary', async () => {
    /**
     * `paused` is a real Stripe subscription status and is absent from the seven
     * the Mongoose model lists. A CHECK rendered from that tuple would reject
     * this write — a live billing webhook — for a value Stripe considers
     * ordinary. This is the assertion that the column was deliberately left
     * open, so a later "tidy-up" adding the CHECK fails here rather than in
     * production.
     */
    await db.insert(subscriptions).values({
      id: 'sub-paused',
      oxyUserId: 'oxy-user-1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      stripePriceId: 'price_1',
      status: 'paused',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      planSnapshotName: 'Pro',
      planSnapshotCreditsPerMonth: 1000,
      planSnapshotPrice: 2000,
    });

    const [row] = await db
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.id, 'sub-paused'));
    expect(row?.status).toBe('paused');
  });

  it('refuses a credit package granting no credits', async () => {
    const insert = db.execute(sql`
      insert into ${creditPackages} (id, package_id, name, credits, price)
      values ('pkg-zero', 'zero', 'Zero', 0, 100)
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('credit_packages_credits_check');
      return true;
    });
  });
});

describe('a credit balance is keyed by the Oxy account, not by a row identity', () => {
  it('refuses a balance row with no id, because there is no default to invent one', async () => {
    /**
     * The single place in this schema where `generatedId()` would be wrong. A
     * uuid v7 default would mint a row that no lookup could ever find, and the
     * failure would present as a missing balance rather than a bad insert.
     */
    const insert = db.execute(sql`
      insert into ${userCredits} (credits_last_refresh) values (now())
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      // 23502 not_null_violation — no `isNotNullViolation` predicate is exported,
      // so this asserts the SQLSTATE the driver reports.
      expect((error as { cause?: { code?: string } }).cause?.code).toBe('23502');
      return true;
    });
  });

  it('accepts the Oxy account id as the primary key', async () => {
    await db.insert(userCredits).values({ id: 'oxy-user-42', creditsLastRefresh: new Date() });

    const [row] = await db
      .select({ id: userCredits.id, free: userCredits.creditsFree })
      .from(userCredits)
      .where(eq(userCredits.id, 'oxy-user-42'));

    expect(row?.id).toBe('oxy-user-42');
    // The Mongoose defaults came across with the columns.
    expect(row?.free).toBe(300);
  });
});
