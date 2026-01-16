import mongoose, { Schema, Model, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  email: string;
  password?: string;
  name: {
    first: string;
    middle?: string;
    last?: string;
  };
  image?: string;
  credits: {
    free: number;          // Current free credits balance
    freeLimit: number;     // Max free credits (resets to this daily)
    dailyRefresh: number;  // Amount to refresh daily
    lastRefresh: Date;     // Last time credits were refreshed
  };
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  refreshCreditsIfNeeded(): Promise<void>;
}

const UserSchema = new Schema<IUser>({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: false }, // Opcional si usas OAuth en el futuro
  name: {
    first: { type: String, required: true },
    middle: { type: String },
    last: { type: String },
  },
  image: { type: String },
  credits: {
    free: { type: Number, default: 1000 },
    freeLimit: { type: Number, default: 1000 },
    dailyRefresh: { type: Number, default: 300 },
    lastRefresh: { type: Date, default: Date.now },
  },
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
}, {
  timestamps: true,
  toJSON: { virtuals: true }, // Asegurar que los virtuales se incluyan al convertir a JSON
  toObject: { virtuals: true }
});

// Virtual para nombre completo
UserSchema.virtual('name.full').get(function() {
  const parts = [this.name.first, this.name.middle, this.name.last].filter(Boolean);
  return parts.join(' ');
});

// Hash password before saving
UserSchema.pre('save', async function() {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) {
    return;
  }

  // Don't hash if password is undefined or empty
  if (!this.password) {
    return;
  }

  // Generate salt and hash password
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare passwords
UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  if (!this.password) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.password);
};

// Method to refresh credits if a day has passed
UserSchema.methods.refreshCreditsIfNeeded = async function(): Promise<void> {
  const now = new Date();
  const lastRefresh = new Date(this.credits.lastRefresh);

  // Check if it's a new day (more than 24 hours since last refresh)
  const hoursSinceRefresh = (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60);

  if (hoursSinceRefresh >= 24) {
    this.credits.free = this.credits.freeLimit;
    this.credits.lastRefresh = now;
    await this.save();
  }
};

// Evitar recompilación del modelo en hot-reload
export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
