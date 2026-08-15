/**
 * Closed value sets for `feature`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

/**
 * Whether a feature is a yes/no entitlement or a numeric allowance. A `limit`
 * feature is the only kind for which `PlanFeature.limitValue` is meaningful.
 */
export const FEATURE_TYPES = ['boolean', 'limit'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];
