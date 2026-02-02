import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IUserCredits extends Document<string> {
  _id: string; // Oxy user ID
  credits: {
    free: number;
    freeLimit: number;
    dailyRefresh: number;
    lastRefresh: Date;
    paid: number;
  };
  stripeCustomerId?: string;
  createdAt: Date;
  updatedAt: Date;
  refreshCreditsIfNeeded(): Promise<void>;
  addCredits(amount: number, type?: 'free' | 'paid'): Promise<void>;
  deductCredits(amount: number): Promise<boolean>;
}

const UserCreditsSchema = new Schema<IUserCredits>({
  _id: { type: String, required: true },
  credits: {
    free: { type: Number, default: 1000 },
    freeLimit: { type: Number, default: 1000 },
    dailyRefresh: { type: Number, default: 300 },
    lastRefresh: { type: Date, default: Date.now },
    paid: { type: Number, default: 0 },
  },
  stripeCustomerId: { type: String },
}, {
  timestamps: true,
});

UserCreditsSchema.methods.refreshCreditsIfNeeded = async function(): Promise<void> {
  const now = new Date();
  const lastRefresh = new Date(this.credits.lastRefresh);
  const hoursSinceRefresh = (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60);

  if (hoursSinceRefresh >= 24) {
    this.credits.free = this.credits.freeLimit;
    this.credits.lastRefresh = now;
    await this.save();
  }
};

UserCreditsSchema.methods.addCredits = async function(amount: number, type: 'free' | 'paid' = 'paid'): Promise<void> {
  if (type === 'free') {
    this.credits.free += amount;
  } else {
    this.credits.paid += amount;
  }
  await this.save();
};

UserCreditsSchema.methods.deductCredits = async function(amount: number): Promise<boolean> {
  const totalCredits = this.credits.paid + this.credits.free;

  if (totalCredits < amount) {
    return false;
  }

  if (this.credits.paid >= amount) {
    this.credits.paid -= amount;
  } else {
    const remaining = amount - this.credits.paid;
    this.credits.paid = 0;
    this.credits.free -= remaining;
  }

  await this.save();
  return true;
};

export const UserCredits: Model<IUserCredits> =
  mongoose.models.UserCredits || mongoose.model<IUserCredits>('UserCredits', UserCreditsSchema);
