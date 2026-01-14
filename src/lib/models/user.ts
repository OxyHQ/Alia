import mongoose, { Schema, Model, Document } from 'mongoose';

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

// Evitar recompilación del modelo en hot-reload
export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
