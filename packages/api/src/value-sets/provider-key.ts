/**
 * A provider key's environment, entitlement tier and rotation cadence.
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

/** Which deployment a key belongs to. */
export const PROVIDER_KEY_ENVIRONMENTS = ['production', 'staging', 'development'] as const;

export type ProviderKeyEnvironment = (typeof PROVIDER_KEY_ENVIRONMENTS)[number];

/**
 * The commercial tier of the ACCOUNT the key belongs to. Deliberately NOT
 * `MODEL_PRICING_TIERS`: this one carries `enterprise` and that one does not, so
 * a single shared tuple would silently widen one of the two.
 */
export const PROVIDER_KEY_TIERS = ['free', 'freemium', 'paid', 'enterprise'] as const;

export type ProviderKeyTier = (typeof PROVIDER_KEY_TIERS)[number];

/** How often the key is expected to be rotated. */
export const PROVIDER_KEY_ROTATION_SCHEDULES = ['manual', 'monthly', 'quarterly', 'yearly'] as const;

export type ProviderKeyRotationSchedule = (typeof PROVIDER_KEY_ROTATION_SCHEDULES)[number];
