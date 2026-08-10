/**
 * Whether a plan feature is a switch or a quota.
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

/**
 * Whether a feature is a yes/no entitlement or a numeric allowance. A `limit`
 * feature is the only kind for which `PlanFeature.limitValue` is meaningful.
 */
export const FEATURE_TYPES = ['boolean', 'limit'] as const;

export type FeatureType = (typeof FEATURE_TYPES)[number];
