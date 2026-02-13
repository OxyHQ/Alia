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
    free: { type: Number, default: 300 },
    freeLimit: { type: Number, default: 300 },
    dailyRefresh: { type: Number, default: 300 },
    lastRefresh: { type: Date, default: Date.now },
    paid: { type: Number, default: 0 },
  },
  stripeCustomerId: { type: String },
}, {
  timestamps: true,
});

UserCreditsSchema.index({ stripeCustomerId: 1 }, { sparse: true });

UserCreditsSchema.methods.refreshCreditsIfNeeded = async function(): Promise<void> {
  const now = new Date();
  const lastRefresh = new Date(this.credits.lastRefresh);
  const hoursSinceRefresh = (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60);

  if (hoursSinceRefresh >= 24) {
    const result = await UserCredits.findOneAndUpdate(
      { _id: this._id, 'credits.lastRefresh': this.credits.lastRefresh },
      { $set: { 'credits.free': this.credits.freeLimit, 'credits.lastRefresh': now } },
      { new: true }
    );
    if (result) {
      this.credits.free = result.credits.free;
      this.credits.lastRefresh = result.credits.lastRefresh;
    }
  }
};

UserCreditsSchema.methods.addCredits = async function(amount: number, type: 'free' | 'paid' = 'paid'): Promise<void> {
  const field = type === 'free' ? 'credits.free' : 'credits.paid';
  const result = await UserCredits.findByIdAndUpdate(
    this._id,
    { $inc: { [field]: amount } },
    { new: true }
  );
  if (result) {
    this.credits = result.credits;
  }
};

UserCreditsSchema.methods.deductCredits = async function(amount: number): Promise<boolean> {
  const totalCredits = this.credits.paid + this.credits.free;
  if (totalCredits < amount) {
    return false;
  }

  // Deduct from paid first, then free
  if (this.credits.paid >= amount) {
    const result = await UserCredits.findOneAndUpdate(
      { _id: this._id, 'credits.paid': { $gte: amount } },
      { $inc: { 'credits.paid': -amount } },
      { new: true }
    );
    if (result) {
      this.credits = result.credits;
      return true;
    }
    return false;
  }

  const fromPaid = this.credits.paid;
  const fromFree = amount - fromPaid;
  const result = await UserCredits.findOneAndUpdate(
    { _id: this._id, 'credits.free': { $gte: fromFree } },
    { $set: { 'credits.paid': 0 }, $inc: { 'credits.free': -fromFree } },
    { new: true }
  );
  if (result) {
    this.credits = result.credits;
    return true;
  }
  return false;
};

export const UserCredits: Model<IUserCredits> =
  mongoose.models.UserCredits || mongoose.model<IUserCredits>('UserCredits', UserCreditsSchema);
