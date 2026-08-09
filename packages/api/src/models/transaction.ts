import mongoose, { Schema, Model, Document } from 'mongoose';

/** What the money was for. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_TYPES = ['credit_purchase', 'subscription_payment', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/** Where the transaction got to. Alia's own vocabulary, not a payment provider's. */
export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export interface ITransaction extends Document {
  oxyUserId: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  type: 'credit_purchase' | 'subscription_payment' | 'refund';
  amount: number;
  currency: string;
  credits: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  description?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema = new Schema<ITransaction>({
  oxyUserId: {
    type: String,
    required: true,
  },
  stripeCustomerId: {
    type: String,
  },
  stripePaymentIntentId: {
    type: String,
    unique: true,
    sparse: true,
  },
  type: {
    type: String,
    enum: [...TRANSACTION_TYPES],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: 'usd',
  },
  credits: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: [...TRANSACTION_STATUSES],
    default: 'pending',
  },
  description: {
    type: String,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

// Indexes (stripePaymentIntentId is already indexed via unique: true)
TransactionSchema.index({ oxyUserId: 1, createdAt: -1 });
TransactionSchema.index({ status: 1 });
TransactionSchema.index({ 'metadata.dedup': 1 }, { unique: true, sparse: true });

export const Transaction: Model<ITransaction> = mongoose.models.Transaction || mongoose.model<ITransaction>('Transaction', TransactionSchema);
