import mongoose, { Schema, Model, Document } from 'mongoose';

// Validation constants
export const MAX_MEMORIES_FREE = 100;
export const MAX_MEMORIES_PRO = 1000;
export const MAX_MEMORIES_BUSINESS = -1; // Unlimited
export const MAX_MEMORY_VALUE_LENGTH = 10000;
export const MAX_MEMORY_KEY_LENGTH = 200;
export const MAX_CATEGORY_LENGTH = 50;

// Helper to get memory limit based on plan name
export const getMemoryLimit = (planName?: string): number => {
  if (!planName) return MAX_MEMORIES_FREE;

  const plan = planName.toLowerCase();
  if (plan.includes('business') || plan.includes('enterprise')) {
    return MAX_MEMORIES_BUSINESS; // Unlimited
  }
  if (plan.includes('pro')) {
    return MAX_MEMORIES_PRO;
  }

  return MAX_MEMORIES_FREE;
};

export interface IUserMemory extends Document {
  oxyUserId: mongoose.Types.ObjectId;
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
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
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

// Performance indexes
// Text index for full-text search on memory keys and values
UserMemorySchema.index({ 'memories.key': 'text', 'memories.value': 'text' });

// Category index for filtering
UserMemorySchema.index({ 'memories.category': 1 });

// Timestamp index for sorting
UserMemorySchema.index({ 'memories.updatedAt': -1 });

export const UserMemory: Model<IUserMemory> =
  mongoose.models.UserMemory || mongoose.model<IUserMemory>('UserMemory', UserMemorySchema);
