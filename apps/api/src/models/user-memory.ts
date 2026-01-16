import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IUserMemory extends Document {
  userId: mongoose.Types.ObjectId;
  memories: {
    key: string;
    value: string;
    category?: string;
    createdAt: Date;
    updatedAt: Date;
  }[];
  preferences: {
    language?: string;
    tone?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
    [key: string]: any;
  };
  context: {
    occupation?: string;
    location?: string;
    timezone?: string;
    bio?: string;
    [key: string]: any;
  };
  createdAt: Date;
  updatedAt: Date;
}

const UserMemorySchema = new Schema<IUserMemory>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  memories: [{
    key: { type: String, required: true },
    value: { type: String, required: true },
    category: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  }],
  preferences: {
    language: { type: String },
    tone: { type: String },
    responseLength: { type: String, enum: ['short', 'medium', 'long'] },
    interests: [{ type: String }]
  },
  context: {
    occupation: { type: String },
    location: { type: String },
    timezone: { type: String },
    bio: { type: String }
  }
}, {
  timestamps: true
});

// Note: userId already has a unique index from the schema definition (unique: true)
// No need for explicit index here

export const UserMemory: Model<IUserMemory> =
  mongoose.models.UserMemory || mongoose.model<IUserMemory>('UserMemory', UserMemorySchema);
