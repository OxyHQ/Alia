/**
 * Closed value sets for `plan`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/** The product a plan sells. `Subscription.plan.product` is the same vocabulary. */
export const PLAN_PRODUCTS = ['alia', 'codea'] as const;
export type PlanProduct = (typeof PLAN_PRODUCTS)[number];
/** How a plan is billed. `Subscription.billingPeriod` is the same vocabulary. */
export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
