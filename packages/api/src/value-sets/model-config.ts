/**
 * Which pricing tier serves a provider model.
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

/** Commercial tier of a provider model's published pricing. */
export const MODEL_PRICING_TIERS = ['free', 'freemium', 'paid'] as const;

export type ModelPricingTier = (typeof MODEL_PRICING_TIERS)[number];
