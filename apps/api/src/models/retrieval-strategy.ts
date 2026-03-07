import mongoose, { Schema, Model, Document } from 'mongoose';

export type AutonomyIntent =
  | 'meeting_prep'
  | 'inbox_digest'
  | 'project_status'
  | 'task_followup'
  | 'monitoring'
  | 'research'
  | 'general';

export interface IRetrievalSourceStep {
  sourceKey: string;
  order: number;
  required: boolean;
  fallbackSourceKeys: string[];
}

export interface IRetrievalStrategy extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  intent: AutonomyIntent;
  name: string;
  active: boolean;
  sourceSteps: IRetrievalSourceStep[];
  freshnessWeight: number;
  precisionWeight: number;
  costWeight: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RetrievalSourceStepSchema = new Schema<IRetrievalSourceStep>({
  sourceKey: { type: String, required: true },
  order: { type: Number, required: true },
  required: { type: Boolean, default: false },
  fallbackSourceKeys: [{ type: String }],
}, { _id: false });

const RetrievalStrategySchema = new Schema<IRetrievalStrategy>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  intent: {
    type: String,
    enum: ['meeting_prep', 'inbox_digest', 'project_status', 'task_followup', 'monitoring', 'research', 'general'],
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  sourceSteps: { type: [RetrievalSourceStepSchema], default: [] },
  freshnessWeight: { type: Number, default: 0.4 },
  precisionWeight: { type: Number, default: 0.4 },
  costWeight: { type: Number, default: 0.2 },
  successCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },
  avgLatencyMs: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: undefined },
}, { timestamps: true });

RetrievalStrategySchema.index({ oxyUserId: 1, intent: 1, active: 1 });
RetrievalStrategySchema.index({ oxyUserId: 1, intent: 1, name: 1 }, { unique: true });

export const RetrievalStrategy: Model<IRetrievalStrategy> =
  mongoose.models.RetrievalStrategy || mongoose.model<IRetrievalStrategy>('RetrievalStrategy', RetrievalStrategySchema);
