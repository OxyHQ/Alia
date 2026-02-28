import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgentSessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
}

export interface IAgentSessionResource {
  type: 'vm' | 'container';
  resourceId: string;
  ip?: string;
  previewUrl?: string;
  status: 'active' | 'destroyed';
  createdAt: Date;
}

export interface IEventStreamEntry {
  seq: number;
  timestamp: number;
  type: 'user_message' | 'system_message' | 'action' | 'observation' | 'error' | 'plan_update' | 'thinking' | 'response' | 'complete';
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    exitCode?: number;
    durationMs?: number;
    tokenEstimate?: number;
  };
}

export interface ITodoItem {
  id: number;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface IStructuredPlan {
  objective: string;
  items: ITodoItem[];
}

export interface ICreditReservation {
  userId: string;
  creditsReserved: number;
  initialFreeCredits: number;
  initialPaidCredits: number;
}

export interface IAgentSession extends Document {
  agentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  parentSessionId?: mongoose.Types.ObjectId;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  task: string;
  result?: string;
  plan?: IStructuredPlan;
  messages: IAgentSessionMessage[];
  eventStream: IEventStreamEntry[];
  resources: IAgentSessionResource[];
  creditReservation?: ICreditReservation;
  stats: {
    totalTokens: number;
    totalSteps: number;
    creditsCharged?: number;
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
  plan: {
    type: {
      objective: { type: String, default: '' },
      items: [{
        id: { type: Number, default: 0 },
        text: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'in_progress', 'completed', 'blocked'], default: 'pending' },
      }],
    },
    default: undefined,
  },
  messages: [{
    role: { type: String, enum: ['system', 'user', 'assistant', 'tool'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  }],
  eventStream: [{
    seq: { type: Number, required: true },
    timestamp: { type: Number, required: true },
    type: {
      type: String,
      enum: ['user_message', 'system_message', 'action', 'observation', 'error', 'plan_update', 'thinking', 'response', 'complete'],
      required: true,
    },
    content: { type: String, required: true },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  }],
  resources: [{
    type: { type: String, enum: ['vm', 'container'], required: true },
    resourceId: { type: String, required: true },
    ip: { type: String },
    previewUrl: { type: String },
    status: { type: String, enum: ['active', 'destroyed'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
  }],
  creditReservation: {
    type: {
      userId: { type: String },
      creditsReserved: { type: Number },
      initialFreeCredits: { type: Number },
      initialPaidCredits: { type: Number },
    },
    default: undefined,
  },
  stats: {
    totalTokens: { type: Number, default: 0 },
    totalSteps: { type: Number, default: 0 },
    creditsCharged: { type: Number },
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
