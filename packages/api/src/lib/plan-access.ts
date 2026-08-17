/**
 * The entitlement READ MODEL — what an account may do, and nothing about what it
 * owes.
 *
 * ADR 0005 splits Alia's billing domain in two: the entitlement decision stays
 * here because it runs on every turn and cannot afford a network hop, while the
 * financial record moves to Oxy. This module is the whole of the first half.
 *
 * ## The shape is `@oxyhq/contracts`'s, not a local invention
 *
 * `entitlement` is a `ProductEntitlement`, parsed through the contract's own
 * schema before it is returned, so a value this module produces is by
 * construction a value Oxy can serve and a consumer can parse. That is the
 * point of expressing it here first: when Oxy becomes authoritative the fields
 * are already the right fields, and the migration is a change of SOURCE rather
 * than a change of shape.
 *
 * The three legacy fields beside it — `allowedModelIds`, `features`, `planId` —
 * are Alia's own product derivations and are DERIVED FROM the same reads, not
 * from a second query. `allowedModelIds` in particular has no contract
 * counterpart on purpose: which models a plan advertises is a catalogue decision
 * this product owns, not an allowance Oxy meters.
 *
 * ## `payAsYouGo` is `null`, and that is a measurement rather than a stub
 *
 * The contract reserves `null` for "no billing profile anywhere up this
 * account's ancestry" — a real state, distinct from a zero balance. Alia holds
 * no Oxy billing profile today, so `null` is the true answer.
 *
 * It must NOT be synthesised from `user_credits`. That table is the financial
 * half: putting a balance into this object would merge the two halves ADR 0005
 * separates, inside the one interface whose whole job is keeping them apart —
 * and the contract's own comment says the same, since `purchasedBalance` and
 * `promotionalBalance` are exact decimal MONEY while an Alia credit is a count.
 * `billingSeparation.test.ts` fails if this module acquires a financial import.
 *
 * ## Allowances are the numeric limits only
 *
 * A plan feature with a `limitValue` is an allowance — a whole count of
 * something included per period, which is exactly what
 * `planAllowanceSchema.included` is. A feature with no limit is a CAPABILITY: on
 * or off, no quantity, nothing to meter. Rendering the second as an allowance of
 * 1 would invent a number nothing counts down.
 *
 * Results are cached per-user with a short TTL.
 */

import {
  LIVE_PRODUCT_PLAN_STATUSES,
  planAllowanceSchema,
  productEntitlementSchema,
  productPlanStatusSchema,
  type PlanAllowance,
  type ProductEntitlement,
} from '@oxyhq/contracts';
import { getDb } from '../db/index.js';
import { findActiveSubscriptions, type SubscriptionRow } from '../db/billing/subscriptionRepository.js';
import { getPlans, getPlanFeatures, type PlanFeatureData } from './gateway-client.js';
import { TTLCache } from './ttl-cache.js';

const FREE_MODEL_IDS = ['alia-lite', 'alia-v1', 'alia-v1-audio'];

export interface Entitlements {
  allowedModelIds: string[];
  features: Record<string, boolean | number>;
  planId: string | null;
  /**
   * The same decision in the Oxy contract's own shape. This is the interface
   * between Oxy and Alia; the three fields above are Alia-local derivations of
   * it plus the model catalogue.
   */
  entitlement: ProductEntitlement;
}

const cache = new TTLCache<Entitlements>({ ttlMs: 5 * 60 * 1000, maxSize: 5000 });

/**
 * An Alia `feature_id` as an allowance key the contract will accept, or `null`.
 *
 * The two namespaces do not coincide and the difference is one character:
 * Alia's feature ids are kebab-case (`voice-minutes`) and the contract's
 * `planAllowanceSchema.key` is a machine name with no hyphen. A hyphen is
 * therefore an underscore here — injective over every seeded id, because none
 * of them contains an underscore already.
 *
 * **The predicate is the contract's own schema, never a copy of its pattern.**
 * A retyped regex is a second statement of somebody else's rule that can drift
 * from it silently, and the drift shows up as a hot-path parse throwing.
 *
 * `null` for a key that still does not fit, and the CALLER drops it rather than
 * throwing: `getUserEntitlements` failing takes the model gate with it —
 * `request-context.ts` reads a rejected promise as "no entitlements" and skips
 * the check entirely — so a bad key would open every model to everybody. It
 * cannot happen silently either: `billingSeparation.test.ts` walks the seeded
 * feature ids and fails on one this cannot express.
 */
export function allowanceKeyFor(featureId: string): string | null {
  const key = featureId.replaceAll('-', '_');
  return planAllowanceSchema.safeParse({ key, included: 0 }).success ? key : null;
}

/**
 * The numeric limits among a set of plan features, as contract allowances.
 *
 * Highest wins across plans, matching `features` — an account holding two plans
 * gets the better of the two allowances rather than whichever was read last.
 */
function allowancesFrom(planFeatures: PlanFeatureData[]): PlanAllowance[] {
  const highest = new Map<string, number>();
  for (const pf of planFeatures) {
    if (pf.limitValue == null) continue;
    const key = allowanceKeyFor(pf.featureId);
    if (key === null) continue;
    highest.set(key, Math.max(highest.get(key) ?? 0, pf.limitValue));
  }
  return [...highest].map(([key, included]) => ({ key, included }));
}

/**
 * One live subscription as the contract's plan.
 *
 * `subscriptions.status` carries no CHECK because Stripe owns that vocabulary,
 * so it reaches here as a bare `string` and is narrowed by the contract's own
 * enum. That parse cannot fire today — the row came from
 * `findActiveSubscriptions`, which filters to `LIVE_SUBSCRIPTION_STATUSES`, and
 * `billingSeparation.test.ts` asserts every member of that tuple is in
 * `PRODUCT_PLAN_STATUSES` — and it throws rather than dropping the plan if that
 * ever stops holding, because a silently absent plan is a paying customer
 * refused their models.
 *
 * `live` is DERIVED from the contract's own list rather than hardcoded `true`:
 * the day this reads a wider set of statuses, the flag has to follow it.
 */
function planFrom(
  subscription: SubscriptionRow,
  planId: string,
  allowances: PlanAllowance[],
): NonNullable<ProductEntitlement['plan']> {
  const status = productPlanStatusSchema.parse(subscription.status);
  return {
    id: planId,
    name: subscription.planSnapshotName,
    status,
    live: (LIVE_PRODUCT_PLAN_STATUSES as readonly string[]).includes(status),
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    allowances,
  };
}

export async function getUserEntitlements(userId: string): Promise<Entitlements> {
  const cached = cache.get(userId);
  if (cached) return cached;

  const subscriptions = await findActiveSubscriptions(getDb(), userId);

  const planIds = subscriptions
    .map(s => s.planSnapshotPlanId)
    .filter(Boolean) as string[];
  if (planIds.length === 0) planIds.push('free');

  // Fetch all plans and filter client-side (providers API returns all plans)
  const [allPlans, allPlanFeatures] = await Promise.all([
    getPlans(),
    Promise.all(planIds.map(id => getPlanFeatures(id))).then(results => results.flat()),
  ]);
  const plans = allPlans.filter(p => planIds.includes(p.planId));
  const planFeatures = allPlanFeatures.filter(pf => pf.enabled !== false);

  const modelIds = new Set(FREE_MODEL_IDS);
  for (const plan of plans) {
    plan.modelIds?.forEach(id => modelIds.add(id));
  }

  const features: Record<string, boolean | number> = {};
  for (const pf of planFeatures) {
    if (pf.limitValue != null) {
      features[pf.featureId] = Math.max(
        (features[pf.featureId] as number) || 0,
        pf.limitValue,
      );
    } else {
      features[pf.featureId] = true;
    }
  }

  const highestPlan = planIds.includes('free') && planIds.length === 1
    ? 'free'
    : planIds.find(id => id !== 'free') || 'free';

  const allowances = allowancesFrom(planFeatures);
  // The subscription the `planId` above names, so the two cannot disagree. An
  // account on the free floor holds none, and the contract's plan is then null.
  const held = subscriptions.find(s => s.planSnapshotPlanId === highestPlan);

  const result: Entitlements = {
    allowedModelIds: [...modelIds],
    features,
    planId: highestPlan,
    entitlement: productEntitlementSchema.parse({
      schemaVersion: 1,
      accountId: userId,
      plan: held ? planFrom(held, highestPlan, allowances) : null,
      allowances,
      payAsYouGo: null,
      costCenter: null,
      resolvedAt: new Date().toISOString(),
    }),
  };

  cache.set(userId, result);
  return result;
}

export function invalidateEntitlementsCache(userId: string): void {
  cache.delete(userId);
}
