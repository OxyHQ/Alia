import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgent extends Document {
  name: string;
  handle: string;
  avatar: string | null;
  tagline: string;
  description: string;
  author: mongoose.Types.ObjectId;
  authorName: string;
  authorVerified: boolean;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  price: number | null;
  capabilities: string[];
  skills: mongoose.Types.ObjectId[];
  knowledge: mongoose.Types.ObjectId[];
  isVerified: boolean;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  creditBalance: number;
  allowHiring: boolean;
  systemPrompt?: string;
  preferredImage?: string;
  allowedModels: string[];
  scheduleInterval?: number;
  lastScheduledCheck?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AgentSchema = new Schema<IAgent>({
  name: { type: String, required: true },
  handle: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  avatar: { type: String, default: null },
  tagline: { type: String, required: true },
  description: { type: String, required: true },
  author: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  authorName: { type: String, required: true },
  authorVerified: { type: Boolean, default: false },
  category: { type: String, required: true, index: true },
  tags: [{ type: String }],
  rating: { type: Number, default: 0, min: 0, max: 5 },
  reviewCount: { type: Number, default: 0 },
  usageCount: { type: Number, default: 0 },
  hireCount: { type: Number, default: 0 },
  price: { type: Number, default: null },
  capabilities: [{ type: String }],
  skills: [{
    type: Schema.Types.ObjectId,
    ref: 'Skill',
  }],
  knowledge: [{
    type: Schema.Types.ObjectId,
    ref: 'LibraryFile',
  }],
  isVerified: { type: Boolean, default: false },
  isFeatured: { type: Boolean, default: false },
  isTrending: { type: Boolean, default: false },
  isPublished: { type: Boolean, default: true },
  status: {
    type: String,
    enum: ['active', 'idle', 'offline'],
    default: 'active',
  },
  creditBalance: { type: Number, default: 0 },
  allowHiring: { type: Boolean, default: false },
  systemPrompt: { type: String },
  preferredImage: { type: String },
  allowedModels: {
    type: [String],
    default: ['alia-lite', 'alia-v1'],
  },
  scheduleInterval: { type: Number },
  lastScheduledCheck: { type: Date },
}, {
  timestamps: true,
});

AgentSchema.index({ isPublished: 1, isFeatured: -1, createdAt: -1 });
AgentSchema.index({ category: 1, isPublished: 1 });

export const Agent: Model<IAgent> = mongoose.models.Agent || mongoose.model<IAgent>('Agent', AgentSchema);
