import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IContainer extends Document {
  containerId: string;
  name: string;
  sessionId: mongoose.Types.ObjectId;
  agentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  image: string;
  size: 'small' | 'medium' | 'large';
  status: 'creating' | 'running' | 'idle' | 'stopped' | 'destroyed';
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
    enum: ['small', 'medium', 'large'],
    default: 'small',
  },
  status: {
    type: String,
    enum: ['creating', 'running', 'idle', 'stopped', 'destroyed'],
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
