import mongoose, { Schema, Model, Document } from 'mongoose';

export type LearningRuleType = 'correction' | 'strategy' | 'preference' | 'constraint';

export interface ILearningRule extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  intent: string;
  ruleType: LearningRuleType;
  priority: number;
  title: string;
  ruleText: string;
  source: 'user_feedback' | 'runtime' | 'system';
  active: boolean;
  hitCount: number;
  lastAppliedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LearningRuleSchema = new Schema<ILearningRule>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  intent: { type: String, required: true, default: 'general', index: true },
  ruleType: {
    type: String,
    enum: ['correction', 'strategy', 'preference', 'constraint'],
    required: true,
  },
  priority: { type: Number, default: 50, index: true },
  title: { type: String, required: true },
  ruleText: { type: String, required: true },
  source: {
    type: String,
    enum: ['user_feedback', 'runtime', 'system'],
    required: true,
    default: 'runtime',
  },
  active: { type: Boolean, default: true },
  hitCount: { type: Number, default: 0 },
  lastAppliedAt: { type: Date, default: undefined },
}, { timestamps: true });

LearningRuleSchema.index({ oxyUserId: 1, intent: 1, active: 1, priority: -1 });

export const LearningRule: Model<ILearningRule> =
  mongoose.models.LearningRule || mongoose.model<ILearningRule>('LearningRule', LearningRuleSchema);
