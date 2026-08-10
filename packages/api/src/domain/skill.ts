/**
 * Closed value sets for `skill`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/**
 * Exported as a TUPLE, not a union type: the Postgres schema renders its CHECK
 * from this exact value rather than retyping it, so the constraint and this
 * validator cannot drift apart.
 */
export const SKILL_CATEGORIES = ['featured', 'community', 'recent'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];
