/**
 * stripe-prices.ts — Auto-create Stripe Products + Prices on demand.
 *
 * When a Plan lacks a stripeMonthlyPriceId or stripeAnnualPriceId,
 * this module creates the corresponding Stripe objects and persists
 * the IDs back to the plan document for future use.
 */

import type Stripe from 'stripe';
import { getPlans, updatePlan } from './providers-client.js';
import { log } from './logger.js';

type StripeFn = () => Stripe;

/**
 * Ensure a Stripe Product exists for the given plan.
 * Creates one if stripeProductId is missing.
 */
async function ensureStripeProduct(getStripe: StripeFn, plan: any): Promise<string> {
  if (plan.stripeProductId) {
    return plan.stripeProductId;
  }

  const product = await getStripe().products.create({
    name: `${plan.name} Plan`,
    metadata: { planId: plan.planId, product: plan.product },
  });

  try {
    await updatePlan(plan.planId, { stripeProductId: product.id });
  } catch (err) {
    log.credits.warn({ err, planId: plan.planId }, 'Failed to persist stripeProductId');
  }

  log.credits.info({ planId: plan.planId, stripeProductId: product.id }, 'Auto-created Stripe product');
  return product.id;
}

/**
 * Ensure a Stripe Price ID exists for the given plan and billing period.
 *
 * Returns the existing price ID if set, otherwise creates a Stripe
 * Product (if needed) and Price, persists the IDs, and returns the price ID.
 */
export async function ensureStripePriceId(
  getStripe: StripeFn,
  planId: string,
  billingPeriod: 'monthly' | 'annual',
): Promise<string> {
  const plans = await getPlans({ planId });
  const plan = plans[0];
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const isAnnual = billingPeriod === 'annual';
  const field = isAnnual ? 'stripeAnnualPriceId' : 'stripeMonthlyPriceId';
  const existing = plan[field];

  if (existing) {
    return existing;
  }

  const stripeProductId = await ensureStripeProduct(getStripe, plan);

  const price = await getStripe().prices.create({
    product: stripeProductId,
    unit_amount: isAnnual ? plan.annualPrice : plan.monthlyPrice,
    currency: plan.currency,
    recurring: { interval: isAnnual ? 'year' : 'month' },
    metadata: { planId: plan.planId, billingPeriod },
  });

  try {
    await updatePlan(plan.planId, { [field]: price.id });
  } catch (err) {
    log.credits.warn({ err, planId: plan.planId }, 'Failed to persist stripe price ID');
  }

  log.credits.info({ planId: plan.planId, billingPeriod, stripePriceId: price.id }, 'Auto-created Stripe price');
  return price.id;
}
