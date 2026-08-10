/**
 * Closed value sets for `provider-key`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
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
