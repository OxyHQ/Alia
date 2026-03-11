import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IRoutingLog extends Document {
  agentId: mongoose.Types.ObjectId;
  oxyUserId: mongoose.Types.ObjectId;
  triggerId?: mongoose.Types.ObjectId;
  inboundChannel: string;
  inboundSummary: string;
  classification: {
    category: string;
    priority: string;
    confidence: number;
  };
  routedTo: {
    type: 'agent' | 'team' | 'user';
    id: string;
    name: string;
  } | null;
  reasoning: string;
  status: 'routed' | 'acknowledged' | 'escalated' | 'resolved';
  createdAt: Date;
  resolvedAt?: Date;
}

const RoutingLogSchema = new Schema<IRoutingLog>({
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, index: true },
  oxyUserId: { type: Schema.Types.ObjectId, required: true, index: true },
  triggerId: { type: Schema.Types.ObjectId, ref: 'Trigger' },
  inboundChannel: { type: String, required: true },
  inboundSummary: { type: String, required: true },
  classification: {
    category: { type: String, required: true },
    priority: { type: String, required: true },
    confidence: { type: Number, default: 0 },
  },
  routedTo: {
    type: {
      type: String,
      enum: ['agent', 'team', 'user'],
    },
    id: String,
    name: String,
  },
  reasoning: { type: String, default: '' },
  status: {
    type: String,
    enum: ['routed', 'acknowledged', 'escalated', 'resolved'],
    default: 'routed',
  },
  resolvedAt: { type: Date },
}, {
  timestamps: true,
});

// TTL: auto-delete after 90 days
RoutingLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
RoutingLogSchema.index({ agentId: 1, createdAt: -1 });

export const RoutingLog: Model<IRoutingLog> =
  mongoose.models.RoutingLog || mongoose.model<IRoutingLog>('RoutingLog', RoutingLogSchema);
