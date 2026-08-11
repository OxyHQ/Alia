/**
 * Live subscriptions, mirrored from Stripe, on Postgres.
 *
 * ## "The user's active subscription" was AMBIGUOUS, and now it is not
 *
 * Six call sites read one subscription with `findOne({ oxyUserId, status: { $in:
 * ['active','trialing'] } })`. Two of them sorted; four did not — and a user can
 * genuinely hold more than one, which `routes/codea.ts` says out loud ("user may
 * have both Alia and Codea"). So those four returned whichever document the
 * index happened to yield, and three of them fed `getMemoryLimit()`: an
 * arbitrary memory allowance for anyone holding two subscriptions.
 *
 * There is no Postgres equivalent of "arbitrary" and porting arbitrariness
 * faithfully is not an option, so every unqualified read is now the MOST
 * RECENTLY CREATED active subscription — which is what the two sites that did
 * sort already asked for, and what the field is read as meaning everywhere it is
 * displayed. A deliberate behaviour change, called out because it is one.
 *
 * `created_at` is `notNull`, so no `NULLS LAST` is needed here — unlike the
 * `last_failure` ordering in `authHealthRepository`, where it was load-bearing.
 *
 * ## `plan_snapshot_*` is what was SOLD
 *
 * Mongo nested a `plan` object beside the top-level `planId`, so `planId` and
 * `billingPeriod` appear twice. Readers of `subscription.plan.name` and
 * `.plan.planId` now read `planSnapshotName` / `planSnapshotPlanId`: the frozen
 * record of what the customer agreed to, which must not move when an admin edits
 * the catalogue.
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { count } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { subscriptions } from '../schema/billing';

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type SubscriptionInsert = typeof subscriptions.$inferInsert;

/** Stripe's own words for "this subscription is live". */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

function liveFor(oxyUserId: string, product?: string): SQL {
  const conditions: SQL[] = [
    eq(subscriptions.oxyUserId, oxyUserId),
    inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
  ];
  if (product !== undefined) {
    conditions.push(eq(subscriptions.planSnapshotProduct, product));
  }
  const where = and(...conditions);
  if (!where) throw new Error('unreachable: at least two conditions');
  return where;
}

/**
 * The account's most recently created live subscription, or `null`.
 *
 * See the file comment: "most recent" is a decision, not an inheritance.
 */
export async function findActiveSubscription(
  db: ApiDatabase,
  oxyUserId: string,
  options: { product?: string } = {},
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(liveFor(oxyUserId, options.product))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return row ?? null;
}

/** Every live subscription for the account, newest first. */
export async function findActiveSubscriptions(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(liveFor(oxyUserId))
    .orderBy(desc(subscriptions.createdAt));
}

/**
 * The live subscription whose billing period started most recently.
 *
 * A different ordering from `findActiveSubscription`, and deliberately so: the
 * voice-minutes entitlement is measured from the CURRENT period's start, which
 * is not necessarily the newest subscription's creation date.
 */
export async function findActiveSubscriptionByPeriodStart(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(liveFor(oxyUserId))
    .orderBy(desc(subscriptions.currentPeriodStart))
    .limit(1);
  return row ?? null;
}

export async function findSubscriptionByStripeId(
  db: ApiDatabase,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
  return row ?? null;
}

/** Create or refresh the mirror of one Stripe subscription. */
export async function upsertSubscriptionByStripeId(
  db: ApiDatabase,
  values: SubscriptionInsert,
): Promise<SubscriptionRow> {
  const { stripeSubscriptionId, ...rest } = values;
  const [row] = await db
    .insert(subscriptions)
    .values({ stripeSubscriptionId, ...rest })
    .onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: { ...rest, updatedAt: sql`date_trunc('milliseconds', now())` },
    })
    .returning();
  if (!row) throw new Error('subscription upsert returned no row');
  return row;
}

/**
 * What may be rewritten on an existing subscription.
 *
 * The `plan_snapshot_*` fields are in here despite being "what was sold": a plan
 * CHANGE is the customer agreeing to something different, so the snapshot moves
 * with it. What the snapshot must never do is follow an admin's edit to the
 * catalogue, and nothing here lets it.
 */
export type SubscriptionUpdate = Partial<
  Pick<
    SubscriptionInsert,
    | 'status'
    | 'cancelAtPeriodEnd'
    | 'planId'
    | 'billingPeriod'
    | 'stripePriceId'
    | 'planSnapshotPlanId'
    | 'planSnapshotName'
    | 'planSnapshotProduct'
    | 'planSnapshotCreditsPerMonth'
    | 'planSnapshotPrice'
    | 'planSnapshotCurrency'
    | 'planSnapshotBillingPeriod'
  >
>;

/**
 * Apply an update to one subscription by its Stripe id.
 *
 * `null` means no such subscription — the discrimination the source got from
 * `findOneAndUpdate` returning null, which `handleSubscriptionDeleted` uses to
 * decide whether to invalidate a cache.
 */
export async function updateSubscriptionByStripeId(
  db: ApiDatabase,
  stripeSubscriptionId: string,
  updates: SubscriptionUpdate,
): Promise<SubscriptionRow | null> {
  if (Object.keys(updates).length === 0) {
    return findSubscriptionByStripeId(db, stripeSubscriptionId);
  }
  const [row] = await db
    .update(subscriptions)
    .set(updates)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .returning();
  return row ?? null;
}

export interface AdminSubscriptionFilter {
  readonly status?: string;
  readonly product?: string;
}

function adminWhere(filter: AdminSubscriptionFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) conditions.push(eq(subscriptions.status, filter.status));
  // Mongo's `'plan.product'` — the SNAPSHOT, what was sold, not the live plan.
  if (filter.product !== undefined) {
    conditions.push(eq(subscriptions.planSnapshotProduct, filter.product));
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** The admin list, newest first. */
export async function selectSubscriptions(
  db: ApiDatabase,
  filter: AdminSubscriptionFilter,
  page: { limit: number; offset: number },
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(adminWhere(filter))
    .orderBy(desc(subscriptions.createdAt))
    .limit(page.limit)
    .offset(page.offset);
}

export async function countSubscriptions(
  db: ApiDatabase,
  filter: AdminSubscriptionFilter,
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(subscriptions).where(adminWhere(filter));
  return row?.total ?? 0;
}

/** One account's subscriptions, newest first — the admin summary. */
export async function selectSubscriptionsForUser(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.oxyUserId, oxyUserId))
    .orderBy(desc(subscriptions.createdAt));
}
