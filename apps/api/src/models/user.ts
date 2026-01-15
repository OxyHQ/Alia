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
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
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

// Evitar recompilación del modelo en hot-reload
export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
