import mongoose, { Schema, Model, Document } from 'mongoose';

export type RollbackStatus = 'open' | 'rolled_back' | 'expired' | 'failed';

export interface IRollbackRecord extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  sessionId: string;
  toolName: string;
  riskLevel: 'R1';
  args: Record<string, unknown>;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  diff?: string;
  rollbackAction?: Record<string, unknown>;
  status: RollbackStatus;
  reason?: string;
  expiresAt: Date;
  executedAt: Date;
  rolledBackAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RollbackRecordSchema = new Schema<IRollbackRecord>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  toolName: { type: String, required: true, index: true },
  riskLevel: { type: String, enum: ['R1'], required: true, default: 'R1' },
  args: { type: Schema.Types.Mixed, required: true },
  beforeState: { type: Schema.Types.Mixed, default: undefined },
  afterState: { type: Schema.Types.Mixed, default: undefined },
  diff: { type: String, default: undefined },
  rollbackAction: { type: Schema.Types.Mixed, default: undefined },
  status: {
    type: String,
    enum: ['open', 'rolled_back', 'expired', 'failed'],
    default: 'open',
    index: true,
  },
  reason: { type: String, default: undefined },
  expiresAt: { type: Date, required: true, index: true },
  executedAt: { type: Date, default: Date.now },
  rolledBackAt: { type: Date, default: undefined },
}, { timestamps: true });

RollbackRecordSchema.index({ oxyUserId: 1, sessionId: 1, status: 1, createdAt: -1 });

export const RollbackRecord: Model<IRollbackRecord> =
  mongoose.models.RollbackRecord || mongoose.model<IRollbackRecord>('RollbackRecord', RollbackRecordSchema);
