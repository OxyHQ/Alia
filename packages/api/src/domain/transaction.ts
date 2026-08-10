/**
 * Closed value sets for `transaction`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/** What the money was for. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_TYPES = ['credit_purchase', 'subscription_payment', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
/** Where the transaction got to. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
