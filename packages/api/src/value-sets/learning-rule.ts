/**
 * What a learned rule asserts, and who taught it.
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
 * Exported as TUPLES, not union types: the Postgres schema renders its CHECKs
 * from these exact values, and a second copy there could disagree with the
 * validator that has been guarding these columns.
 */
export const LEARNING_RULE_TYPES = ['correction', 'strategy', 'preference', 'constraint'] as const;

export type LearningRuleType = (typeof LEARNING_RULE_TYPES)[number];

export const LEARNING_RULE_SOURCES = ['user_feedback', 'runtime', 'system'] as const;

export type LearningRuleSource = (typeof LEARNING_RULE_SOURCES)[number];
