/**
 * Closed value sets for `provider-key`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
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
/**
 * How a key's included credit comes back, if it does.
 *
 * The distinction is load-bearing rather than descriptive. `never` is a GRANT: a
 * one-off pot (a startup-plan credit, a promotional balance) that is gone when
 * it is spent, and a key holding one is correctly retired for good. The others
 * are a QUOTA: an allowance the provider restores every period, so retiring the
 * key permanently throws away every future period's allowance — which is exactly
 * what happened before this existed, silently, because `spent_usd` was set to
 * the limit and nothing ever set it back.
 */
export const PROVIDER_KEY_CREDIT_RENEWALS = ['never', 'weekly', 'monthly'] as const;
export type ProviderKeyCreditRenewal = (typeof PROVIDER_KEY_CREDIT_RENEWALS)[number];
/** How often the key is expected to be rotated. */
export const PROVIDER_KEY_ROTATION_SCHEDULES = ['manual', 'monthly', 'quarterly', 'yearly'] as const;
export type ProviderKeyRotationSchedule = (typeof PROVIDER_KEY_ROTATION_SCHEDULES)[number];
