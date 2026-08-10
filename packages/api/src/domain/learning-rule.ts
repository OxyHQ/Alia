/**
 * Closed value sets for `learning-rule`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/**
 * Exported as TUPLES, not union types: the Postgres schema renders its CHECKs
 * from these exact values, and a second copy there could disagree with the
 * validator that has been guarding these columns.
 */
export const LEARNING_RULE_TYPES = ['correction', 'strategy', 'preference', 'constraint'] as const;
export type LearningRuleType = (typeof LEARNING_RULE_TYPES)[number];
export const LEARNING_RULE_SOURCES = ['user_feedback', 'runtime', 'system'] as const;
export type LearningRuleSource = (typeof LEARNING_RULE_SOURCES)[number];
