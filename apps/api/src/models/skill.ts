import mongoose, { Schema, Model, Document } from 'mongoose';

export interface ISkill extends Document {
  skillId: string;
  title: string;
  tagline: string;
  description: string;
  systemPrompt: string;
  author: string;
  icon: string;
  color: string;
  category: 'featured' | 'community' | 'recent';
  language: string;
  triggers: string[];
  includes: string[];
  useCase: string;
  goodAt: string[];
  notGoodAt: string[];
  isBuiltIn: boolean;
  isPublished: boolean;
  oxyUserId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SkillSchema = new Schema<ISkill>({
  skillId: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  tagline: { type: String, required: true },
  description: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  author: { type: String, required: true },
  icon: { type: String, required: true },
  color: { type: String, required: true },
  category: { type: String, enum: ['featured', 'community', 'recent'], required: true },
  language: { type: String, required: true, default: 'en', index: true },
  triggers: [{ type: String }],
  includes: [{ type: String }],
  useCase: { type: String },
  goodAt: [{ type: String }],
  notGoodAt: [{ type: String }],
  isBuiltIn: { type: Boolean, default: true },
  isPublished: { type: Boolean, default: false, index: true },
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
}, { timestamps: true });

export const Skill: Model<ISkill> = mongoose.models.Skill || mongoose.model<ISkill>('Skill', SkillSchema);
