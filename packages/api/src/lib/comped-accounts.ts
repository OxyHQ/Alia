/**
 * Comped accounts: an Oxy username that always holds the top plan.
 *
 * `oxy` is the platform's own account, and it is expected to hold the most
 * expensive plan of every product without ever going through Stripe. This
 * module is where that grant is made real.
 *
 * ## Why a SUBSCRIPTION ROW rather than an entitlement override
 *
 * "The active plan" is not read in one place. `lib/plan-access.ts` derives
 * models and features from it, but `routes/memory.ts`,
 * `middleware/api-key-rate-limit.ts` and `routes/codea.ts` each read
 * `subscriptions` directly. An override inside the entitlement read model would
 * grant the models and leave the memory allowance, the API-key rate limit and
 * the Codea gate on the free floor — a plan that is Ultra on one surface and
 * Free on three. Writing the row is what makes every reader agree, because the
 * row is what every reader reads.
 *
 * ## The plan is MEASURED, not named
 *
 * "The most expensive plan" is a fact about the catalogue, and the catalogue is
 * admin-editable data. Hardcoding `ultra` here would silently stop being the
 * most expensive plan the day a pricier one is seeded, so the plan is picked by
 * `monthly_price` out of the live active, non-free plans of each product.
 *
 * ## What the synthetic Stripe ids mean
 *
 * `subscriptions.stripe_subscription_id` is `notNull` and uniquely indexed
 * because every row was a mirror of a Stripe object. A comped row has no Stripe
 * object, so it carries a deterministic `comp_<userId>_<product>` id instead:
 * deterministic so the upsert is idempotent, and prefixed so the two routes that
 * hand that id to Stripe (`/subscription/cancel`, `/subscription/change-plan`)
 * can refuse it with a clear 400 rather than a Stripe 404 wearing a 500.
 * `isCompedSubscriptionId` is that predicate, and it is the only reason the
 * prefix is exported.
 *
 * `plan_snapshot_price` is `0`. The snapshot is what the customer AGREED TO PAY,
 * and a comped account agreed to pay nothing; storing the list price would put
 * revenue that does not exist into every report that sums the column.
 *
 * ## What this does NOT do
 *
 * It grants no credits. `user_credits` is the financial half (ADR 0005) and is
 * moved by Stripe webhooks writing a dedup-keyed transaction; minting a balance
 * here would be a credit grant with no transaction behind it. A comped account
 * therefore holds the top plan — every model, every feature, every limit — and
 * spends the same daily free credits as anyone else until a grant path exists.
 */

import type { OxyRequestUser } from '@oxyhq/core/server';

import { getDb } from '../db/index.js';
import {
  findSubscriptionByStripeId,
  upsertSubscriptionByStripeId,
  type SubscriptionRow,
} from '../db/billing/subscriptionRepository.js';
import { getPlans, type PlanData } from './gateway-client.js';
import { log } from './logger.js';
import { invalidateEntitlementsCache } from './plan-access.js';
import { TTLCache } from './ttl-cache.js';

/**
 * The Oxy usernames that hold the top plan of every product.
 *
 * Compared lower-cased, because Oxy handles are displayed in whatever case they
 * were registered in and this must not be a check that a capital letter defeats.
 */
export const COMPED_USERNAMES: ReadonlySet<string> = new Set(['oxy']);

/** The marker that says "this subscription has no Stripe object behind it". */
const COMPED_ID_PREFIX = 'comp_';

export function isCompedSubscriptionId(stripeSubscriptionId: string): boolean {
  return stripeSubscriptionId.startsWith(COMPED_ID_PREFIX);
}

/**
 * Accounts already checked this window.
 *
 * The grant runs on the auth path, so without this it would be two queries on
 * every request the comped account makes. Ten minutes is short enough that a
 * catalogue change reaches the account promptly and long enough that the steady
 * state is one cache hit.
 */
const ensured = new TTLCache<true>({ ttlMs: 10 * 60 * 1000, maxSize: 100 });

interface BillingPeriod {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The current UTC calendar month.
 *
 * A comped subscription has no invoice to take a period from, and the period is
 * not decorative: `findActiveSubscriptionByPeriodStart` measures voice minutes
 * from `current_period_start`, so a period frozen at the day of the grant would
 * accumulate usage forever and shrink the allowance to nothing. A calendar month
 * rolls on its own — the next ensure after the 1st writes the new one — with no
 * scheduler and no drift.
 */
function currentMonth(): BillingPeriod {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/**
 * The dearest active, paid plan of each product.
 *
 * Ties break on `planId` so two plans at the same price cannot make the grant
 * flip between them from one call to the next — a flapping row that would
 * invalidate the entitlement cache on every ensure.
 */
function mostExpensivePlanPerProduct(plans: readonly PlanData[]): Map<PlanData['product'], PlanData> {
  const best = new Map<PlanData['product'], PlanData>();
  for (const plan of plans) {
    if (plan.isFree || !plan.isActive) continue;
    const held = best.get(plan.product);
    const wins =
      !held ||
      plan.monthlyPrice > held.monthlyPrice ||
      (plan.monthlyPrice === held.monthlyPrice && plan.planId < held.planId);
    if (wins) best.set(plan.product, plan);
  }
  return best;
}

/**
 * Whether the stored row already says what the grant would say.
 *
 * Every field the grant sets and something reads: the status and the plan
 * because they are the grant, `cancel_at_period_end` because a cancel attempt
 * must not stick, and the period because it rolls monthly. Comparing them is
 * what keeps `invalidateEntitlementsCache` — and the write itself — off the
 * steady-state path.
 */
function matchesGrant(row: SubscriptionRow | null, plan: PlanData, period: BillingPeriod): boolean {
  return (
    row !== null &&
    row.status === 'active' &&
    row.planId === plan.planId &&
    row.planSnapshotPlanId === plan.planId &&
    row.planSnapshotName === plan.name &&
    row.planSnapshotCreditsPerMonth === plan.creditsPerMonth &&
    !row.cancelAtPeriodEnd &&
    row.currentPeriodStart.getTime() === period.start.getTime() &&
    row.currentPeriodEnd.getTime() === period.end.getTime()
  );
}

/**
 * Give a comped account the top plan of every product, if it does not have it.
 *
 * Called from the auth middleware, so it must never fail a request: an account
 * that cannot be granted its comp is an account on the free plan, which is the
 * same state it was in a moment ago. The failure is logged and the request
 * continues.
 *
 * Not a no-op for a non-comped user by accident — it returns before touching the
 * database for anyone whose username is not in `COMPED_USERNAMES`.
 */
export async function ensureCompedSubscriptions(
  user: OxyRequestUser | null | undefined,
): Promise<void> {
  const username = typeof user?.username === 'string' ? user.username.toLowerCase() : null;
  if (!user?.id || username === null || !COMPED_USERNAMES.has(username)) return;
  if (ensured.get(user.id)) return;

  try {
    const db = getDb();
    const period = currentMonth();
    const plans = mostExpensivePlanPerProduct(await getPlans({ isActive: true, isFree: false }));

    let granted = false;
    for (const plan of plans.values()) {
      const stripeSubscriptionId = `${COMPED_ID_PREFIX}${user.id}_${plan.product}`;
      const existing = await findSubscriptionByStripeId(db, stripeSubscriptionId);
      if (matchesGrant(existing, plan, period)) continue;

      await upsertSubscriptionByStripeId(db, {
        oxyUserId: user.id,
        stripeCustomerId: `${COMPED_ID_PREFIX}${user.id}`,
        stripeSubscriptionId,
        stripePriceId: `${COMPED_ID_PREFIX}${plan.planId}_monthly`,
        status: 'active',
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: false,
        planId: plan.planId,
        billingPeriod: 'monthly',
        planSnapshotPlanId: plan.planId,
        planSnapshotName: plan.name,
        planSnapshotProduct: plan.product,
        planSnapshotCreditsPerMonth: plan.creditsPerMonth,
        // Comped: nothing was agreed to be paid. See the file comment.
        planSnapshotPrice: 0,
        planSnapshotCurrency: plan.currency,
        planSnapshotBillingPeriod: 'monthly',
      });
      granted = true;
      log.credits.info(
        { userId: user.id, username, planId: plan.planId, product: plan.product },
        'Comped subscription granted',
      );
    }

    if (granted) invalidateEntitlementsCache(user.id);
    ensured.set(user.id, true);
  } catch (error: unknown) {
    log.credits.error({ err: error, userId: user.id }, 'Failed to ensure comped subscription');
  }
}
