/**
 * Plan access & entitlements helper.
 * Resolves which models and features a user can access based on their subscription(s).
 * Results are cached per-user with a short TTL.
 */

import { Subscription } from '../models/subscription.js';
import { getPlans, getPlanFeatures } from './gateway-client.js';

const FREE_MODEL_IDS = ['clarity-fast', 'clarity-v1', 'clarity-v1'];

export interface Entitlements {
  allowedModelIds: string[];
  features: Record<string, boolean | number>;
  planId: string | null;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, { data: Entitlements; expires: number }>();

export async function getUserEntitlements(userId: string): Promise<Entitlements> {
  const cached = cache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.data;

  const subscriptions = await Subscription.find({
    oxyUserId: userId,
    status: { $in: ['active', 'trialing'] },
  }).lean();

  const planIds = subscriptions
    .map(s => s.plan?.planId)
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

  const result: Entitlements = {
    allowedModelIds: [...modelIds],
    features,
    planId: highestPlan,
  };

  cache.set(userId, { data: result, expires: Date.now() + CACHE_TTL });
  return result;
}

export function invalidateEntitlementsCache(userId: string): void {
  cache.delete(userId);
}
