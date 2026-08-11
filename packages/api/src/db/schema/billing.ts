/**
 * What is for sale, who bought it, and what they have left.
 *
 * Seven tables: the catalogue (`plans`, `features`, `plan_features`,
 * `credit_packages`), the commercial records (`subscriptions`, `transactions`)
 * and the balance (`user_credits`).
 *
 * ## Money is `bigint` minor units, and every amount here really is one
 *
 * Every price in this domain is handed to Stripe as `unit_amount` or read back
 * as `amount_total` — both are integer cents. So `bigint({ mode: 'number' })`,
 * the Oxy convention, with no exception of the kind `cost_entries.cost_usd`
 * needed. `credits` is NOT money: it is a count of AI credits, an `integer`.
 *
 * **The read side of that has a trap.** postgres.js decodes `bigint`/`int8` as a
 * STRING, so `amount + 1` type-checks clean and is string concatenation. drizzle
 * escapes it via `mode: 'number'`, which is why every money column here declares
 * it — but the same trap reaches any `sum()` or `max()` over these columns, which
 * drizzle types as `number` and postgres.js still returns as a string. Coerce at
 * that boundary; a test doing ONE aggregation cannot tell the two apart.
 *
 * ## What carries a foreign key, and what deliberately does not
 *
 * `plan_features` is a junction table and carries both, to `plans.plan_id` and
 * `features.feature_id` — business keys rather than surrogate ids, because that
 * is what Mongo stored and what every reader passes. Both targets are declared
 * `unique()` rather than `uniqueIndex()`: drizzle-kit emits every FK statement
 * BEFORE every `CREATE UNIQUE INDEX`, so a foreign key pointing at a unique
 * index generates cleanly and fails at apply time with `42830`.
 *
 * `subscriptions.plan_id` and `transactions` carry NONE. They are commercial
 * records that must outlive the catalogue rows they were sold from — a plan
 * withdrawn from sale must not be undeletable, and must not take a customer's
 * receipt with it. What was actually sold is preserved in the
 * `plan_snapshot_*` columns instead, which is the point of a snapshot.
 */

import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { BILLING_PERIODS, PLAN_PRODUCTS } from '../../domain/plan.js';
import { FEATURE_TYPES } from '../../domain/feature.js';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '../../domain/transaction.js';

/**
 * A subscription plan offered for a product.
 *
 * `model_ids` is a `text[]` of `alia_models.alias_model_id` values and carries
 * NO foreign key — Postgres cannot constrain array MEMBERS to another table's
 * column. The seed rewrites it wholesale on every run (`$set`, deliberately, so
 * the list stays code-managed while the prices stay admin-managed), so a stale
 * member is corrected on the next boot rather than persisting.
 */
export const plans = pgTable(
  'plans',
  {
    id: generatedId(),
    /**
     * The business key every other table names a plan by, and the target of
     * `plan_features.plan_id`. `unique()`, not `uniqueIndex()` — see the file
     * comment.
     */
    planId: text().notNull(),
    name: text().notNull(),
    product: text({ enum: PLAN_PRODUCTS as unknown as [string, ...string[]] }).notNull(),

    creditsPerMonth: integer().notNull().default(0),
    dailyFreeCredits: integer().notNull().default(300),
    /** Cents, as handed to Stripe's `unit_amount`. */
    monthlyPrice: bigint({ mode: 'number' }).notNull().default(0),
    annualPrice: bigint({ mode: 'number' }).notNull().default(0),
    /**
     * No CHECK. The Mongoose field is a bare `String` defaulting to `'usd'` with
     * no enum, and the value is passed straight to Stripe, which owns the
     * currency vocabulary. The `auth_health_metrics.method` rule, twice over.
     */
    currency: text().notNull().default('usd'),

    subtitle: text().notNull().default(''),
    creditsLabel: text().notNull().default(''),
    isFeatured: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    /**
     * The `alia_models.alias_model_id`s this plan includes — Alia-branded alias
     * ids like `alia-v1-pro`, never a provider model id.
     *
     * Deliberately NOT a foreign key: it is a plan's advertised contents, and a
     * model being retired from the catalogue must not cascade into deleting or
     * silently emptying a plan somebody is paying for. `routes/plans.ts`
     * validates the ids on write instead, through `findExistingAliasModelIds`.
     *
     * This sentence is the only surviving copy. It was a trailing comment on the
     * Mongoose Plan model's `modelIds`, which the Postgres port deletes, and two
     * other files cited it by that path until this column took it over.
     */
    modelIds: text().array().notNull().default(sql`'{}'::text[]`),

    isActive: boolean().notNull().default(true),
    isFree: boolean().notNull().default(false),

    stripeProductId: text(),
    stripeMonthlyPriceId: text(),
    stripeAnnualPriceId: text(),

    description: text(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('plans_plan_id_key').on(t.planId),
    index('plans_product_sort_order_idx').on(t.product, t.sortOrder),
    index('plans_product_active_idx').on(t.product, t.isActive),
    checkOneOf('plans_product_check', t.product, PLAN_PRODUCTS),
  ],
);

/**
 * A capability a plan may grant, for the pricing comparison table.
 *
 * `feature_type` decides whether `plan_features.limit_value` means anything: a
 * `boolean` feature is on or off, a `limit` feature carries an allowance.
 */
export const features = pgTable(
  'features',
  {
    id: generatedId(),
    /** The business key, and the target of `plan_features.feature_id`. */
    featureId: text().notNull(),
    label: text().notNull(),
    description: text(),
    icon: text(),
    category: text().notNull(),
    featureType: text({ enum: FEATURE_TYPES as unknown as [string, ...string[]] })
      .notNull()
      .default('boolean'),
    sortOrder: integer().notNull().default(0),
    isVisibleOnPricing: boolean().notNull().default(true),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('features_feature_id_key').on(t.featureId),
    index('features_category_sort_order_idx').on(t.category, t.sortOrder),
    checkOneOf('features_feature_type_check', t.featureType, FEATURE_TYPES),
  ],
);

/**
 * Which features a plan grants, and on what terms.
 *
 * A junction table in Mongo too, so this is the one table in the batch whose
 * shape does not change. Both foreign keys CASCADE: a mapping is meaningless
 * without either side, and leaving it behind would let a re-created plan or
 * feature silently inherit a withdrawn plan's entitlements.
 *
 * `UNIQUE(plan_id, feature_id)` is the arbiter that both the seed and
 * `POST /plan-features/bulk` infer on.
 */
export const planFeatures = pgTable(
  'plan_features',
  {
    id: generatedId(),
    planId: text().notNull(),
    featureId: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** Meaningful only when the feature's `feature_type` is `limit`. */
    limitValue: integer(),
    displayLabel: text(),
    displayDescription: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'plan_features_plan_id_fk',
      columns: [t.planId],
      foreignColumns: [plans.planId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'plan_features_feature_id_fk',
      columns: [t.featureId],
      foreignColumns: [features.featureId],
    }).onDelete('cascade'),
    uniqueIndex('plan_features_plan_feature_key').on(t.planId, t.featureId),
    index('plan_features_feature_id_idx').on(t.featureId),
  ],
);

/**
 * A one-off credit purchase package.
 */
export const creditPackages = pgTable(
  'credit_packages',
  {
    id: generatedId(),
    packageId: text().notNull(),
    name: text().notNull(),
    credits: integer().notNull(),
    /** Cents, as handed to Stripe's `unit_amount`. */
    price: bigint({ mode: 'number' }).notNull(),
    currency: text().notNull().default('usd'),
    stripePriceId: text(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('credit_packages_package_id_key').on(t.packageId),
    index('credit_packages_active_sort_order_idx').on(t.isActive, t.sortOrder),
    // Mongoose min, preserved: a package granting no credits is not a package,
    // and a negative price would be a refund wearing a product's name.
    check('credit_packages_credits_check', sql`${t.credits} >= 1`),
    check('credit_packages_price_check', sql`${t.price} >= 0`),
  ],
);

/**
 * A customer's live subscription, mirrored from Stripe.
 *
 * ## `status` has NO CHECK, and the reason is not the Mongoose doubt
 *
 * The seven values Mongoose lists are Stripe's subscription statuses as of when
 * the model was written. Stripe also has `paused`, which is absent from that
 * list — so a CHECK rendered from it would reject a webhook the first time a
 * customer pauses, in the billing path, for a value Stripe considers ordinary.
 * The vocabulary belongs to Stripe, which is the same test that reserves `jsonb`
 * for formats somebody else owns. `billing_period` and `plan_snapshot_product`
 * DO carry CHECKs: those are Alia's own vocabulary.
 *
 * ## `plan_snapshot_*` is what was SOLD, not a copy of the catalogue
 *
 * Mongo nested a whole `plan` object beside the top-level `planId`, which is why
 * `planId` and `billingPeriod` appear twice. The nested one is a SNAPSHOT taken
 * when the subscription was created: it is what the customer agreed to and must
 * not move when an admin edits the plan. `plan_id` is the live pointer and
 * carries no foreign key, per the file comment.
 *
 * The three `required: true` snapshot fields are `notNull` here. A `required`
 * added to a Mongoose schema binds only writes made after it, so the backfill
 * must audit for older rows lacking a snapshot — and if it finds any, relaxing
 * this is a one-line change while the schema is still inert, where tightening it
 * later would be a `post` migration against live billing data.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    stripeCustomerId: text().notNull(),
    stripeSubscriptionId: text().notNull(),
    stripePriceId: text().notNull(),
    /** Stripe's vocabulary, deliberately unconstrained — see the table comment. */
    status: text().notNull(),
    currentPeriodStart: timestamptz().notNull(),
    currentPeriodEnd: timestamptz().notNull(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    planId: text(),
    billingPeriod: text({ enum: BILLING_PERIODS as unknown as [string, ...string[]] })
      .notNull()
      .default('monthly'),

    planSnapshotPlanId: text(),
    planSnapshotName: text().notNull(),
    planSnapshotProduct: text({ enum: PLAN_PRODUCTS as unknown as [string, ...string[]] })
      .notNull()
      .default('alia'),
    planSnapshotCreditsPerMonth: integer().notNull(),
    /** Cents. What the customer agreed to pay, frozen at creation. */
    planSnapshotPrice: bigint({ mode: 'number' }).notNull(),
    planSnapshotCurrency: text().notNull().default('usd'),
    planSnapshotBillingPeriod: text({ enum: BILLING_PERIODS as unknown as [string, ...string[]] })
      .notNull()
      .default('monthly'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_subscription_id_key').on(t.stripeSubscriptionId),
    index('subscriptions_oxy_user_status_idx').on(t.oxyUserId, t.status),
    index('subscriptions_oxy_user_product_status_idx').on(
      t.oxyUserId,
      t.planSnapshotProduct,
      t.status,
    ),
    index('subscriptions_stripe_customer_id_idx').on(t.stripeCustomerId),
    index('subscriptions_plan_id_idx').on(t.planId),
    checkOneOf('subscriptions_billing_period_check', t.billingPeriod, BILLING_PERIODS),
    checkOneOf('subscriptions_plan_snapshot_product_check', t.planSnapshotProduct, PLAN_PRODUCTS),
    checkOneOf(
      'subscriptions_plan_snapshot_billing_period_check',
      t.planSnapshotBillingPeriod,
      BILLING_PERIODS,
    ),
  ],
);

/**
 * A payment, a refund, or a credit grant.
 *
 * ## `dedup_key` is the double-credit guard, and it was invisible in Mongo
 *
 * `routes/billing.ts` credits a subscription renewal by writing a transaction
 * FIRST as a lock, keyed `<stripeSubscriptionId>_<periodStart>`, and treats the
 * duplicate-key error as "already credited, skip". That guarantee lived in
 * `index({'metadata.dedup': 1}, {unique: true, sparse: true})` — a unique index
 * on a path INSIDE a `Mixed` field. Nothing about `metadata: jsonb` carries it,
 * so a mechanical port drops it and the symptom is a customer credited twice on
 * a webhook redelivery, with no error anywhere.
 *
 * It is a STORED GENERATED column rather than a second real column that writers
 * must remember to fill: callers keep passing `metadata: { dedup }` exactly as
 * they do now, and there is no way to write the metadata without the constraint
 * seeing it. Two representations of one fact could disagree; this cannot.
 *
 * One consequence to know before touching it: a stored generated column is
 * computed AFTER a `BEFORE UPDATE` trigger runs, so `NEW.dedup_key` is NULL
 * inside one. Nothing here uses a trigger, and nothing should start.
 *
 * ## Sparse-unique translates to a plain unique, and that is not a weakening
 *
 * Mongo's `sparse: true` on `stripe_payment_intent_id` exempted documents
 * MISSING the field but still indexed a stored `null`, so a second explicit null
 * was an `E11000`. Postgres treats nulls as distinct in a unique index by
 * default, so the plain `unique` here permits many nulls — strictly more
 * permissive than the source, and correct: a transaction with no payment intent
 * is not a duplicate of another one.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    stripeCustomerId: text(),
    stripePaymentIntentId: text(),
    type: text({ enum: TRANSACTION_TYPES as unknown as [string, ...string[]] }).notNull(),
    /** Cents, as read from Stripe's `amount_total`. */
    amount: bigint({ mode: 'number' }).notNull(),
    currency: text().notNull().default('usd'),
    /** A count of AI credits, NOT money. */
    credits: integer().notNull(),
    status: text({ enum: TRANSACTION_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('pending'),
    description: text(),
    /**
     * `jsonb` earns it here: the shape is whatever the writing call site chose,
     * it differs per transaction type, and no reader addresses a member of it —
     * except `dedup`, which is exactly why that one is lifted out below.
     */
    metadata: jsonb(),
    /**
     * Derived from `metadata`, never written directly. The literal column name
     * in the expression is what a generated column requires; the unique index
     * over it is asserted end to end by `billing.pgdb.test.ts`, which is what
     * would catch the expression going stale.
     */
    dedupKey: text().generatedAlwaysAs(sql`(metadata ->> 'dedup')`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('transactions_stripe_payment_intent_id_key').on(t.stripePaymentIntentId),
    uniqueIndex('transactions_dedup_key_key').on(t.dedupKey),
    index('transactions_oxy_user_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('transactions_status_idx').on(t.status),
    checkOneOf('transactions_type_check', t.type, TRANSACTION_TYPES),
    checkOneOf('transactions_status_check', t.status, TRANSACTION_STATUSES),
  ],
);

/**
 * One account's credit balance.
 *
 * **`id` is an OXY ACCOUNT ID and has no default**, which is the one place in
 * this schema where `generatedId()` would be actively wrong. Mongo declared
 * `_id: { type: String }` and wrote the Oxy user id into it, so this table is
 * keyed by the account rather than by a row identity. A uuid v7 default would
 * quietly mint a row that no lookup could ever find, and the failure would look
 * like a missing balance rather than a bad insert.
 *
 * The `credits` sub-document becomes `credits_*` columns, per the `routing_logs`
 * precedent.
 *
 * **No non-negativity CHECK, deliberately.** Mongoose declared no `min` on any
 * of these, and `addCredits` accepts a negative amount, so production may hold a
 * negative balance today. A CHECK would fail on the first write to such a row —
 * in the deduction path. The backfill audits the actual range; adding the
 * constraint is a decision for after that, not before.
 */
export const userCredits = pgTable(
  'user_credits',
  {
    /** The Oxy account id. No default, and no foreign key — Oxy owns identity. */
    id: text().primaryKey(),
    creditsFree: integer().notNull().default(300),
    creditsFreeLimit: integer().notNull().default(300),
    creditsDailyRefresh: integer().notNull().default(300),
    /**
     * When the free allowance was last topped up. The refresh is a compare-and-
     * set against THIS value, so it is the concurrency control and not merely a
     * diagnostic timestamp.
     */
    creditsLastRefresh: timestamptz().notNull(),
    creditsPaid: integer().notNull().default(0),
    stripeCustomerId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** Partial, the equivalent of Mongo's `sparse: true`. */
    index('user_credits_stripe_customer_id_idx')
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} is not null`),
  ],
);
