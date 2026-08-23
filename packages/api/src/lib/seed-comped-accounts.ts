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
 * ## Why a SEEDER, and not the auth middleware
 *
 * The first version of this ran on the request path and keyed on
 * `req.user.username`. It was INERT in production, and the reason is worth
 * keeping: `@oxyhq/core`'s `oxy.auth()` sets `req.user = { id: userId }` and
 * loads the profile only under `loadUser: true`, which this API does not pass.
 * There is no username on a request to key on, so the account has to be resolved
 * through Oxy — and once a network call is involved, the request path is the
 * wrong place for it.
 *
 * So the grant is a table seeder like `seed-plans.ts`: it runs at the deploy
 * boundary, from `scripts/seed.ts`, which the deploy invokes unconditionally on
 * every release. `db/__tests__/seedWiring.test.ts` is what keeps it wired — an
 * exported zero-argument `seed…()` under `lib/seed-*.ts` that nothing calls
 * fails that gate rather than sitting there looking wired.
 *
 * It throws rather than logging on failure, which fails the deploy. That is the
 * house rule for this entrypoint (`scripts/seed.ts`'s own settlement comment): a
 * seed that reports and exits 0 is the shape that let production run with zero
 * `plans` rows.
 *
 * ## The plan is MEASURED, not named
 *
 * "The most expensive plan" is a fact about the catalogue, and the catalogue is
 * admin-editable data. Hardcoding `ultra` would silently stop being the most
 * expensive plan the day a pricier one is seeded, so the plan is picked by
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
 * spends the same daily free credits as anyone else.
 */

import { OxyServices } from '@oxyhq/core';

import { getDb } from '../db/index.js';
import {
  findSubscriptionByStripeId,
  upsertSubscriptionByStripeId,
  type SubscriptionRow,
} from '../db/billing/subscriptionRepository.js';
import { getPlans, type PlanData } from './gateway-client.js';
import { log } from './logger.js';

/** The Oxy usernames that hold the top plan of every product. */
const COMPED_USERNAMES = ['oxy'] as const;

/** The marker that says "this subscription has no Stripe object behind it". */
const COMPED_ID_PREFIX = 'comp_';

export function isCompedSubscriptionId(stripeSubscriptionId: string): boolean {
  return stripeSubscriptionId.startsWith(COMPED_ID_PREFIX);
}

interface BillingPeriod {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The UTC calendar month this seed runs in.
 *
 * A comped subscription has no invoice to take a period from, and the period is
 * not decorative: `findActiveSubscriptionByPeriodStart` measures voice minutes
 * from `current_period_start`. A period frozen at the first grant would
 * accumulate usage forever and shrink that allowance to nothing, so every
 * release re-stamps it to the current month. Nothing revokes the plan when the
 * period ends — `liveFor` filters on `status` alone — so a release-quiet month
 * costs a wider voice window, not a lost plan.
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
 * flip between them from one release to the next, rewriting the row for nothing.
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
 * because they are the grant, `cancel_at_period_end` because a cancellation must
 * not stick, and the period because it is re-stamped monthly. Comparing them is
 * what keeps a release that changes nothing from writing anything.
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
 * Give every comped account the top plan of every product.
 *
 * Idempotent: a release that changes neither the catalogue nor the month writes
 * nothing. Throws on an unresolvable username or an unreachable Oxy — see the
 * file comment on why that fails the deploy instead of logging.
 */
export async function seedCompedAccounts(): Promise<{ granted: number; unchanged: number }> {
  const db = getDb();
  const period = currentMonth();
  const plans = mostExpensivePlanPerProduct(await getPlans({ isActive: true, isFree: false }));
  if (plans.size === 0) {
    throw new Error('refusing to comp an account: the catalogue has no active paid plan');
  }

  // Alia's own client rather than `middleware/auth.ts`'s: importing that one
  // would pull the express middleware, the developer-key repository and the
  // channel registry into a deploy one-shot that needs none of them.
  const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });

  let granted = 0;
  let unchanged = 0;

  for (const username of COMPED_USERNAMES) {
    // The account id is the only thing a request ever carries, and it is not on
    // the token — see the file comment. Resolved once per release, here.
    const { id: oxyUserId } = await oxy.getProfileByUsername(username);
    if (!oxyUserId) throw new Error(`refusing to comp an account: ${username} resolved to no id`);

    for (const plan of plans.values()) {
      const stripeSubscriptionId = `${COMPED_ID_PREFIX}${oxyUserId}_${plan.product}`;
      const existing = await findSubscriptionByStripeId(db, stripeSubscriptionId);
      if (matchesGrant(existing, plan, period)) {
        unchanged++;
        continue;
      }

      await upsertSubscriptionByStripeId(db, {
        oxyUserId,
        stripeCustomerId: `${COMPED_ID_PREFIX}${oxyUserId}`,
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
      granted++;
      log.seed.info(
        { oxyUserId, username, planId: plan.planId, product: plan.product },
        'Comped subscription granted',
      );
    }
  }

  log.seed.info({ granted, unchanged }, 'Comped account seeding complete');
  return { granted, unchanged };
}
