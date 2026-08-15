/**
 * Closed value sets for `plan`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

/** The product a plan sells. `Subscription.plan.product` is the same vocabulary. */
export const PLAN_PRODUCTS = ['alia', 'codea'] as const;
export type PlanProduct = (typeof PLAN_PRODUCTS)[number];
/** How a plan is billed. `Subscription.billingPeriod` is the same vocabulary. */
export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
