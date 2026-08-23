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
 * ## The credits come with the plan, through the same lock as a paid one
 *
 * A plan is not only a set of models: `plans.credits_per_month` is what the
 * customer gets to spend, and a comped account that held Ultra while spending
 * the 300-a-day free floor had the name of the plan and none of its substance.
 *
 * So this grants them — through the SAME mechanism a Stripe renewal uses, not a
 * second one. `insertTransaction` is written FIRST as a lock: `dedup_key` is a
 * stored generated column over `metadata ->> 'dedup'` with a unique index, so
 * there is no way to write the metadata without the constraint seeing it, and
 * only then is the balance moved. Re-running a release inside the same month
 * therefore credits nothing, and a new month credits exactly once.
 *
 * The transaction carries `amount: 0`. It is a `subscription_payment` because
 * that is what the vocabulary has for "credits arrived with a subscription", and
 * a zero amount is the truthful part: no money moved, so nothing that sums the
 * column counts revenue that does not exist.
 *
 * ## What this still does NOT do
 *
 * It mints no balance outside that lock, and it does not touch `credits_free` —
 * the daily floor stays exactly what every other account gets.
 */

import { OxyServices } from '@oxyhq/core';

import { getDb, type ApiDatabase } from '../db/index.js';
import {
  findSubscriptionByStripeId,
  upsertSubscriptionByStripeId,
  type SubscriptionRow,
} from '../db/billing/subscriptionRepository.js';
import { addCredits } from '../db/billing/userCreditsRepository.js';
import { insertTransaction, isDuplicateTransaction } from '../db/billing/transactionRepository.js';
import { getPlans, type PlanData } from './gateway-client.js';
// The existing owner of "get the balance row, creating it if absent" — the same
// pairing every displaying surface uses, rather than a second call site for it.
import { getOrCreateUserCredits } from './user-credits-helpers.js';
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
 * The plan's monthly credits, once per account per period.
 *
 * Returns whether it credited. The dedup key is the subscription's own id and
 * the period start, exactly as the Stripe renewal path keys it — same shape,
 * same unique index, so the two can never double-credit each other either.
 *
 * The balance row is created first: an account that has never spent anything has
 * no `user_credits` row, and `addCredits` updates rather than inserts.
 */
async function grantMonthlyCredits(
  db: ApiDatabase,
  oxyUserId: string,
  plan: PlanData,
  stripeSubscriptionId: string,
  period: BillingPeriod,
): Promise<boolean> {
  if (plan.creditsPerMonth <= 0) return false;

  const dedup = `${stripeSubscriptionId}_${period.start.toISOString()}`;
  try {
    await insertTransaction(db, {
      oxyUserId,
      type: 'subscription_payment',
      // Comped: no money moved. See the file comment.
      amount: 0,
      currency: plan.currency,
      credits: plan.creditsPerMonth,
      status: 'completed',
      description: `${plan.name} complimentary credits (monthly)`,
      metadata: { dedup },
    });
  } catch (error: unknown) {
    // Already credited for this period — the whole point of the lock.
    if (isDuplicateTransaction(error)) return false;
    throw error;
  }

  await getOrCreateUserCredits(oxyUserId);
  await addCredits(db, oxyUserId, plan.creditsPerMonth, 'paid');
  return true;
}

/**
 * Give every comped account the top plan of every product.
 *
 * Idempotent: a release that changes neither the catalogue nor the month writes
 * nothing. Throws on an unresolvable username or an unreachable Oxy — see the
 * file comment on why that fails the deploy instead of logging.
 */
export async function seedCompedAccounts(): Promise<{
  granted: number;
  unchanged: number;
  credited: number;
}> {
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
  let credited = 0;

  for (const username of COMPED_USERNAMES) {
    // The account id is the only thing a request ever carries, and it is not on
    // the token — see the file comment. Resolved once per release, here.
    const { id: oxyUserId } = await oxy.getProfileByUsername(username);
    if (!oxyUserId) throw new Error(`refusing to comp an account: ${username} resolved to no id`);

    for (const plan of plans.values()) {
      const stripeSubscriptionId = `${COMPED_ID_PREFIX}${oxyUserId}_${plan.product}`;
      /**
       * Before the row is looked at, and deliberately: on the first release
       * after this existed the subscription row already matched while the
       * credits had never been granted, so crediting only on a row CHANGE would
       * have left exactly the account this is for on the free floor. The dedup
       * lock is what makes asking every release cost nothing.
       */
      if (await grantMonthlyCredits(db, oxyUserId, plan, stripeSubscriptionId, period)) {
        credited++;
        log.seed.info(
          { oxyUserId, username, planId: plan.planId, credits: plan.creditsPerMonth },
          'Comped credits granted',
        );
      }

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

  log.seed.info({ granted, unchanged, credited }, 'Comped account seeding complete');
  return { granted, unchanged, credited };
}
