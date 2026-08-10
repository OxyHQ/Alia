/**
 * Which product a plan belongs to, and how often it bills.
 *
 * A CLOSED VALUE SET, declared here rather than in the Mongoose model that used
 * to own it. Both stores read this one tuple: the model's `enum` validator and
 * the Postgres CHECK `db/schema` renders. A second copy can disagree with the
 * first, and the disagreement is invisible until a write hits one and not the
 * other.
 *
 * It lives outside `models/` because `db/schema` imports it as a RUNTIME value,
 * so the schema — and every migration's CHECK — would otherwise depend on a
 * Mongoose model the port is retiring. See `db/schema/CONVENTIONS.md`
 * ("Closed value sets").
 */

/** The product a plan sells. `Subscription.plan.product` is the same vocabulary. */
export const PLAN_PRODUCTS = ['alia', 'codea'] as const;

export type PlanProduct = (typeof PLAN_PRODUCTS)[number];

/** How a plan is billed. `Subscription.billingPeriod` is the same vocabulary. */
export const BILLING_PERIODS = ['monthly', 'annual'] as const;

export type BillingPeriod = (typeof BILLING_PERIODS)[number];
