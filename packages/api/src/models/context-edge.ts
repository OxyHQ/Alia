import mongoose, { Schema, Model, Document } from 'mongoose';
import { CONTEXT_EDGE_TYPES, ContextEdgeType } from '../domain/context-edge.js';

export interface IContextEdge extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  fromNodeId: mongoose.Types.ObjectId;
  toNodeId: mongoose.Types.ObjectId;
  edgeType: ContextEdgeType;
  weight: number;
  metadata?: Record<string, unknown>;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ContextEdgeSchema = new Schema<IContextEdge>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromNodeId: { type: Schema.Types.ObjectId, ref: 'ContextNode', required: true, index: true },
  toNodeId: { type: Schema.Types.ObjectId, ref: 'ContextNode', required: true, index: true },
  edgeType: {
    type: String,
    enum: [...CONTEXT_EDGE_TYPES],
    required: true,
    default: 'unknown',
  },
  weight: { type: Number, default: 0.5 },
  metadata: { type: Schema.Types.Mixed, default: undefined },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

ContextEdgeSchema.index({ oxyUserId: 1, fromNodeId: 1, toNodeId: 1, edgeType: 1 }, { unique: true });
ContextEdgeSchema.index({ oxyUserId: 1, edgeType: 1, updatedAt: -1 });

export const ContextEdge: Model<IContextEdge> =
  mongoose.models.ContextEdge || mongoose.model<IContextEdge>('ContextEdge', ContextEdgeSchema);
