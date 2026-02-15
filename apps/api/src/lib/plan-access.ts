/**
 * Plan access & entitlements helper.
 * Resolves which models and features a user can access based on their subscription(s).
 * Results are cached per-user with a short TTL.
 */

import { Subscription } from '../models/subscription.js';
import { Plan } from '../internal/providers/models/plan.js';
import { PlanFeature } from '../internal/providers/models/plan-feature.js';

const FREE_MODEL_IDS = ['alia-lite', 'alia-v1', 'alia-v1-audio'];

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

  const [plans, planFeatures] = await Promise.all([
    Plan.find({ planId: { $in: planIds } }).lean(),
    PlanFeature.find({ planId: { $in: planIds }, enabled: true }).lean(),
  ]);

  const modelIds = new Set(FREE_MODEL_IDS);
  for (const plan of plans) {
    (plan as any).modelIds?.forEach((id: string) => modelIds.add(id));
  }

  const features: Record<string, boolean | number> = {};
  for (const pf of planFeatures) {
    const pfAny = pf as any;
    if (pfAny.limitValue != null) {
      features[pfAny.featureId] = Math.max(
        (features[pfAny.featureId] as number) || 0,
        pfAny.limitValue,
      );
    } else {
      features[pfAny.featureId] = true;
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
