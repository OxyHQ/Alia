/**
 * Closed value sets for `model-config`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/** Commercial tier of a provider model's published pricing. */
export const MODEL_PRICING_TIERS = ['free', 'freemium', 'paid'] as const;
export type ModelPricingTier = (typeof MODEL_PRICING_TIERS)[number];
