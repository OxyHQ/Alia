import mongoose, { Schema, Model, Document } from 'mongoose';

export type ContextSourceKind =
  | 'calendar'
  | 'email'
  | 'notes'
  | 'files'
  | 'integration'
  | 'oxy_service'
  | 'agent_session'
  | 'web'
  | 'memory'
  | 'unknown';

export interface IContextSource extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  sourceKey: string;
  kind: ContextSourceKind;
  label: string;
  availability: 'available' | 'degraded' | 'disabled';
  freshnessScore: number;
  precisionScore: number;
  avgCostScore: number;
  avgLatencyMs: number;
  successfulReads: number;
  failedReads: number;
  lastSuccessAt?: Date;
  lastErrorAt?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const ContextSourceSchema = new Schema<IContextSource>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceKey: { type: String, required: true },
  kind: {
    type: String,
    enum: ['calendar', 'email', 'notes', 'files', 'integration', 'oxy_service', 'agent_session', 'web', 'memory', 'unknown'],
    required: true,
    default: 'unknown',
  },
  label: { type: String, required: true },
  availability: {
    type: String,
    enum: ['available', 'degraded', 'disabled'],
    default: 'available',
  },
  freshnessScore: { type: Number, default: 0.5 },
  precisionScore: { type: Number, default: 0.5 },
  avgCostScore: { type: Number, default: 0.5 },
  avgLatencyMs: { type: Number, default: 0 },
  successfulReads: { type: Number, default: 0 },
  failedReads: { type: Number, default: 0 },
  lastSuccessAt: { type: Date, default: undefined },
  lastErrorAt: { type: Date, default: undefined },
  metadata: { type: Schema.Types.Mixed, default: undefined },
}, { timestamps: true });

ContextSourceSchema.index({ oxyUserId: 1, sourceKey: 1 }, { unique: true });
ContextSourceSchema.index({ oxyUserId: 1, kind: 1, updatedAt: -1 });

export const ContextSource: Model<IContextSource> =
  mongoose.models.ContextSource || mongoose.model<IContextSource>('ContextSource', ContextSourceSchema);
