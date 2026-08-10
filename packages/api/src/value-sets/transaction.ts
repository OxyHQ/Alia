/**
 * What a billing transaction is and how it ended.
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

/** What the money was for. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_TYPES = ['credit_purchase', 'subscription_payment', 'refund'] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/** Where the transaction got to. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
