/**
 * A reversible action's state and its risk class.
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
 * Exported as a TUPLE, not as a union type, because the Postgres schema renders
 * its CHECK from this exact value. A second copy over there could disagree with
 * the validator that has been guarding this column, and the disagreement would
 * be invisible until a write hit one and not the other.
 */
export const ROLLBACK_STATUSES = ['open', 'rolled_back', 'expired', 'failed'] as const;

export type RollbackStatus = (typeof ROLLBACK_STATUSES)[number];

/** Only R1 actions open a rollback window. Same tuple rule as above. */
export const ROLLBACK_RISK_LEVELS = ['R1'] as const;

export type RollbackRiskLevel = (typeof ROLLBACK_RISK_LEVELS)[number];
