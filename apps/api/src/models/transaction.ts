import mongoose, { Schema, Model, Document } from 'mongoose';

export interface ITransaction extends Document {
  oxyUserId: mongoose.Types.ObjectId;
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
    type: Schema.Types.ObjectId,
    ref: 'User',
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
    enum: ['credit_purchase', 'subscription_payment', 'refund'],
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
    enum: ['pending', 'completed', 'failed', 'refunded'],
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

export const Transaction: Model<ITransaction> = mongoose.models.Transaction || mongoose.model<ITransaction>('Transaction', TransactionSchema);
