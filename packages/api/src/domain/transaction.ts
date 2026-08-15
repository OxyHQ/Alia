/**
 * Closed value sets for `transaction`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

/** What the money was for. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_TYPES = ['credit_purchase', 'subscription_payment', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
/** Where the transaction got to. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
