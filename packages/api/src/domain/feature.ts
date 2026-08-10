/**
 * Closed value sets for `feature`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/**
 * Whether a feature is a yes/no entitlement or a numeric allowance. A `limit`
 * feature is the only kind for which `PlanFeature.limitValue` is meaningful.
 */
export const FEATURE_TYPES = ['boolean', 'limit'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];
