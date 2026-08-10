import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Exported as TUPLES, not union types: the Postgres schema renders its CHECKs
 * from these exact values rather than retyping them, so a constraint and the
 * validator guarding the same column cannot drift apart.
 */
export const CONTAINER_SIZES = ['small', 'medium', 'large'] as const;
export type ContainerSize = (typeof CONTAINER_SIZES)[number];

export const CONTAINER_STATUSES = ['creating', 'running', 'idle', 'stopped', 'destroyed'] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

export interface IContainer extends Document {
  containerId: string;
  name: string;
  sessionId: mongoose.Types.ObjectId;
  agentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  image: string;
  size: ContainerSize;
  status: ContainerStatus;
  persistent: boolean;
  previewUrl?: string;
  exposedPorts: number[];
  lastActivityAt: Date;
  destroyedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ContainerSchema = new Schema<IContainer>({
  containerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  sessionId: {
    type: Schema.Types.ObjectId,
    ref: 'AgentSession',
    required: true,
    index: true,
  },
  agentId: {
    type: Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  image: { type: String, required: true },
  size: {
    type: String,
    enum: CONTAINER_SIZES,
    default: 'small',
  },
  status: {
    type: String,
    enum: CONTAINER_STATUSES,
    default: 'creating',
    index: true,
  },
  persistent: { type: Boolean, default: false },
  previewUrl: { type: String },
  exposedPorts: [{ type: Number }],
  lastActivityAt: { type: Date, default: Date.now },
  destroyedAt: { type: Date },
}, {
  timestamps: true,
});

ContainerSchema.index({ userId: 1, status: 1 });

export const Container: Model<IContainer> = mongoose.models.Container || mongoose.model<IContainer>('Container', ContainerSchema);
