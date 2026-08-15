/**
 * Closed value sets for `model-config`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

/** Commercial tier of a provider model's published pricing. */
export const MODEL_PRICING_TIERS = ['free', 'freemium', 'paid'] as const;
export type ModelPricingTier = (typeof MODEL_PRICING_TIERS)[number];
