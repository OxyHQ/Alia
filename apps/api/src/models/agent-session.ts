import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgentSessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
}

export interface IAgentSessionResource {
  type: 'vm';
  resourceId: string;
  ip?: string;
  status: 'active' | 'destroyed';
  createdAt: Date;
}

export interface IAgentSession extends Document {
  agentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  parentSessionId?: mongoose.Types.ObjectId;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  task: string;
  result?: string;
  messages: IAgentSessionMessage[];
  resources: IAgentSessionResource[];
  stats: {
    totalTokens: number;
    totalSteps: number;
    startedAt: Date;
    completedAt?: Date;
    lastActivityAt: Date;
  };
  config: {
    maxSteps: number;
    maxTokens: number;
    maxVMs: number;
  };
  depth: number;
  createdAt: Date;
  updatedAt: Date;
}

const AgentSessionSchema = new Schema<IAgentSession>({
  agentId: {
    type: Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
    index: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  parentSessionId: {
    type: Schema.Types.ObjectId,
    ref: 'AgentSession',
    default: undefined,
  },
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true,
  },
  task: { type: String, required: true },
  result: { type: String },
  messages: [{
    role: { type: String, enum: ['system', 'user', 'assistant', 'tool'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  }],
  resources: [{
    type: { type: String, enum: ['vm'], required: true },
    resourceId: { type: String, required: true },
    ip: { type: String },
    status: { type: String, enum: ['active', 'destroyed'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
  }],
  stats: {
    totalTokens: { type: Number, default: 0 },
    totalSteps: { type: Number, default: 0 },
    startedAt: { type: Date },
    completedAt: { type: Date },
    lastActivityAt: { type: Date, default: Date.now },
  },
  config: {
    maxSteps: { type: Number, default: 50 },
    maxTokens: { type: Number, default: 100000 },
    maxVMs: { type: Number, default: 2 },
  },
  depth: { type: Number, default: 0 },
}, {
  timestamps: true,
});

AgentSessionSchema.index({ agentId: 1, status: 1, createdAt: -1 });

export const AgentSession: Model<IAgentSession> = mongoose.models.AgentSession || mongoose.model<IAgentSession>('AgentSession', AgentSessionSchema);
