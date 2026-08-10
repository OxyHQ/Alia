import mongoose, { Schema, Model, Document } from 'mongoose';
import { CONTEXT_NODE_TYPES, ContextNodeType } from '../domain/context-node.js';

export interface IContextNode extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  nodeKey: string;
  type: ContextNodeType;
  label: string;
  metadata?: Record<string, unknown>;
  freshnessScore: number;
  precisionScore: number;
  costScore: number;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ContextNodeSchema = new Schema<IContextNode>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  nodeKey: { type: String, required: true },
  type: {
    type: String,
    enum: [...CONTEXT_NODE_TYPES],
    required: true,
    default: 'unknown',
  },
  label: { type: String, required: true },
  metadata: { type: Schema.Types.Mixed, default: undefined },
  freshnessScore: { type: Number, default: 0.5 },
  precisionScore: { type: Number, default: 0.5 },
  costScore: { type: Number, default: 0.5 },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

ContextNodeSchema.index({ oxyUserId: 1, nodeKey: 1 }, { unique: true });
ContextNodeSchema.index({ oxyUserId: 1, type: 1, updatedAt: -1 });

export const ContextNode: Model<IContextNode> =
  mongoose.models.ContextNode || mongoose.model<IContextNode>('ContextNode', ContextNodeSchema);

