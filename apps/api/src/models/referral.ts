import mongoose, { Schema, Model, Document } from 'mongoose';
import crypto from 'crypto';

export interface IReferredUser {
  userId: string;
  email?: string;
  creditedAt: Date;
  creditsAwarded: number;
}

export interface IReferral extends Document<string> {
  _id: string; // Oxy user ID
  inviteCode: string;
  referredBy?: string; // userId of who referred this user
  referredUsers: IReferredUser[];
  totalCreditsEarned: number;
  totalReferrals: number;
  createdAt: Date;
  updatedAt: Date;
}

const ReferredUserSchema = new Schema<IReferredUser>({
  userId: { type: String, required: true },
  email: { type: String },
  creditedAt: { type: Date, default: Date.now },
  creditsAwarded: { type: Number, default: 500 },
}, { _id: false });

const ReferralSchema = new Schema<IReferral>({
  _id: { type: String, required: true },
  inviteCode: { type: String, required: true, unique: true },
  referredBy: { type: String },
  referredUsers: { type: [ReferredUserSchema], default: [] },
  totalCreditsEarned: { type: Number, default: 0 },
  totalReferrals: { type: Number, default: 0 },
}, {
  timestamps: true,
});

function generateInviteCode(): string {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
}

export async function getOrCreateReferral(userId: string): Promise<IReferral> {
  // Try up to 3 times in case of invite code collision
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await Referral.findByIdAndUpdate(
        userId,
        {
          $setOnInsert: {
            _id: userId,
            inviteCode: generateInviteCode(),
            referredUsers: [],
            totalCreditsEarned: 0,
            totalReferrals: 0,
          },
        },
        { upsert: true, returnDocument: 'after' }
      );
      return result;
    } catch (err: any) {
      // Duplicate key on inviteCode — retry with new code
      if (err.code === 11000 && attempt < 2) continue;
      throw err;
    }
  }
  // Fallback: just fetch existing
  return Referral.findById(userId) as Promise<IReferral>;
}

export const Referral: Model<IReferral> =
  mongoose.models.Referral || mongoose.model<IReferral>('Referral', ReferralSchema);
