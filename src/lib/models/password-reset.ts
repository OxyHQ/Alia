import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IPasswordReset extends Document {
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

const PasswordResetSchema = new Schema<IPasswordReset>({
  userId: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
}, {
  timestamps: true
});

// Create index to automatically delete expired tokens
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset: Model<IPasswordReset> =
  mongoose.models.PasswordReset || mongoose.model<IPasswordReset>('PasswordReset', PasswordResetSchema);
