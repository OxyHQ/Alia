import mongoose, { Schema, Model, Document } from 'mongoose';

export interface ISubscription extends Document {
  oxyUserId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing' | 'incomplete' | 'incomplete_expired';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  planId?: string;
  billingPeriod: 'monthly' | 'annual';
  plan: {
    planId?: string;
    name: string;
    product: 'clarity' | 'codea';
    creditsPerMonth: number;
    price: number;
    currency: string;
    billingPeriod: 'monthly' | 'annual';
  };
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>({
  oxyUserId: {
    type: String,
    required: true,
  },
  stripeCustomerId: {
    type: String,
    required: true,
  },
  stripeSubscriptionId: {
    type: String,
    required: true,
    unique: true,
  },
  stripePriceId: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete', 'incomplete_expired'],
    required: true,
  },
  currentPeriodStart: {
    type: Date,
    required: true,
  },
  currentPeriodEnd: {
    type: Date,
    required: true,
  },
  cancelAtPeriodEnd: {
    type: Boolean,
    default: false,
  },
  planId: {
    type: String,
    index: true,
  },
  billingPeriod: {
    type: String,
    enum: ['monthly', 'annual'],
    default: 'monthly',
  },
  plan: {
    planId: { type: String },
    name: { type: String, required: true },
    product: { type: String, enum: ['clarity', 'codea'], default: 'clarity' },
    creditsPerMonth: { type: Number, required: true },
    price: { type: Number, required: true },
    currency: { type: String, default: 'usd' },
    billingPeriod: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
  },
}, {
  timestamps: true,
});

// Indexes
SubscriptionSchema.index({ oxyUserId: 1, status: 1 });
SubscriptionSchema.index({ oxyUserId: 1, 'plan.product': 1, status: 1 });
SubscriptionSchema.index({ stripeCustomerId: 1 });

export const Subscription: Model<ISubscription> = mongoose.models.Subscription || mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
