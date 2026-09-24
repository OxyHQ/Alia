/**
 * Billing facade — plans, credit packages and features.
 *
 * It used to also carry a static "routing-profile catalogue" of Alia-branded
 * aliases and a tier→provider mapping table. Alia has no models of its own
 * (ADR 0012): the model catalogue is Oxy's, read by `lib/models/catalogue.ts`.
 * The billing repositories below stay dynamic because they pull in the database.
 */

import type { PlanFilter } from '../db/billing/planRepository.js';

// ============== TYPES ==============

export interface KeyConfig {
  provider: string;
  modelId: string;
  /**
   * Whose machine answers, when `provider` is `user-runtime`.
   *
   * Present for exactly one kind of route and absent for every other: a model
   * served by its owner's own hardware has no credential to carry, so this is
   * what stands in for `key` — the binding that says which person's device, and
   * which of their devices, the request is handed to. See
   * `lib/inference/user-runtime-bridge.ts`.
   */
  userRuntime?: { userId: string; runtimeId: string };
}

// Plain (non-Document) interfaces for billing data returned by API or .lean()
export interface PlanData {
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  isActive: boolean;
  isFree: boolean;
  stripeProductId?: string;
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;
  description?: string;
}

export interface CreditPackageData {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  stripePriceId?: string;
  sortOrder: number;
  isActive: boolean;
  description?: string;
}

export interface FeatureData {
  featureId: string;
  label: string;
  description?: string;
  icon?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
}

export interface PlanFeatureData {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
}

// ============== BILLING DATA ==============

/**
 * Get plans.
 */
export async function getPlans(filter?: PlanFilter): Promise<PlanData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectPlans } = await import('../db/billing/planRepository.js');
  return selectPlans(getDb(), filter ?? {}) as unknown as Promise<PlanData[]>;
}

/**
 * Get credit packages.
 */
export async function getCreditPackages(active?: boolean): Promise<CreditPackageData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectCreditPackages } = await import('../db/billing/creditPackageRepository.js');
  return selectCreditPackages(getDb(), active === undefined ? {} : { isActive: active }) as unknown as CreditPackageData[];
}

/**
 * Get features.
 */
export async function getFeatures(): Promise<FeatureData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectAllFeatures } = await import('../db/billing/featureRepository.js');
  return selectAllFeatures(getDb()) as unknown as FeatureData[];
}

/**
 * Get plan features.
 */
export async function getPlanFeatures(planId?: string): Promise<PlanFeatureData[]> {
  const { getDb } = await import('../db/index.js');
  const { selectPlanFeatures } = await import('../db/billing/planFeatureRepository.js');
  return selectPlanFeatures(getDb(), planId ? { planId } : {}) as unknown as PlanFeatureData[];
}

/**
 * Update a plan (e.g. to persist auto-created Stripe price IDs).
 */
export async function updatePlan(
  planId: string,
  updates: { stripeProductId?: string; stripeMonthlyPriceId?: string; stripeAnnualPriceId?: string },
): Promise<PlanData | null> {
  const { getDb } = await import('../db/index.js');
  const { updatePlanByPlanId } = await import('../db/billing/planRepository.js');
  return updatePlanByPlanId(getDb(), planId, updates) as unknown as Promise<PlanData | null>;
}
