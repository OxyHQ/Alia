/**
 * Closed value sets for `rollback-record`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
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
