import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IOxyServiceEventLog extends Document {
  serviceId: string;
  oxyUserId: mongoose.Types.ObjectId;
  eventId: string;
  eventName: string;
  action: 'notify' | 'context' | 'autonomous';
  status: 'received' | 'processed' | 'failed' | 'duplicate';
  payloadHash?: string;
  agentSessionId?: mongoose.Types.ObjectId;
  errorMessage?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OxyServiceEventLogSchema = new Schema<IOxyServiceEventLog>({
  serviceId: { type: String, required: true, index: true },
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventId: { type: String, required: true },
  eventName: { type: String, required: true },
  action: {
    type: String,
    enum: ['notify', 'context', 'autonomous'],
    required: true,
  },
  status: {
    type: String,
    enum: ['received', 'processed', 'failed', 'duplicate'],
    default: 'received',
    index: true,
  },
  payloadHash: { type: String, default: undefined },
  agentSessionId: { type: Schema.Types.ObjectId, ref: 'AgentSession', default: undefined },
  errorMessage: { type: String, default: undefined },
  processedAt: { type: Date, default: undefined },
}, { timestamps: true });

OxyServiceEventLogSchema.index({ serviceId: 1, oxyUserId: 1, eventId: 1 }, { unique: true });
OxyServiceEventLogSchema.index({ oxyUserId: 1, createdAt: -1 });

export const OxyServiceEventLog: Model<IOxyServiceEventLog> =
  mongoose.models.OxyServiceEventLog || mongoose.model<IOxyServiceEventLog>('OxyServiceEventLog', OxyServiceEventLogSchema);
