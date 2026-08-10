import mongoose, { Schema, Model, Document } from 'mongoose';
import { EVENT_STREAM_ENTRY_TYPES, type EventStreamEntryType } from './event-stream-entry.js';

/**
 * The tuples the Postgres CHECKs render from. Exported rather than retyped, so
 * a constraint and the validator guarding the same column cannot drift.
 *
 * `EVENT_STREAM_ENTRY_TYPES` is IMPORTED, not redeclared: the embedded
 * `eventStream` array below and the `event_stream_entries` collection are the
 * same vocabulary, and they were two identical fourteen-value literals until
 * this batch.
 */
export const AGENT_SESSION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export const AGENT_SESSION_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type AgentSessionMessageRole = (typeof AGENT_SESSION_MESSAGE_ROLES)[number];

export const AGENT_SESSION_RESOURCE_TYPES = ['vm', 'container'] as const;
export type AgentSessionResourceType = (typeof AGENT_SESSION_RESOURCE_TYPES)[number];

export const AGENT_SESSION_RESOURCE_STATUSES = ['active', 'destroyed'] as const;
export type AgentSessionResourceStatus = (typeof AGENT_SESSION_RESOURCE_STATUSES)[number];

export const TODO_ITEM_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const;
export type TodoItemStatus = (typeof TODO_ITEM_STATUSES)[number];

export interface IAgentSessionMessage {
  role: AgentSessionMessageRole;
  content: string;
  timestamp: Date;
}

export interface IAgentSessionResource {
  type: AgentSessionResourceType;
  resourceId: string;
  ip?: string;
  previewUrl?: string;
  status: AgentSessionResourceStatus;
  createdAt: Date;
}

export interface IEventStreamEntry {
  seq: number;
  timestamp: number;
  type: EventStreamEntryType;
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
  status: TodoItemStatus;
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
  status: AgentSessionStatus;
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
    enum: AGENT_SESSION_STATUSES,
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
        status: { type: String, enum: TODO_ITEM_STATUSES, default: 'pending' },
      }],
    },
    default: undefined,
  },
  messages: [{
    role: { type: String, enum: AGENT_SESSION_MESSAGE_ROLES, required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  }],
  eventStream: [{
    seq: { type: Number, required: true },
    timestamp: { type: Number, required: true },
    type: {
      type: String,
      enum: EVENT_STREAM_ENTRY_TYPES,
      required: true,
    },
    content: { type: String, required: true },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  }],
  resources: [{
    type: { type: String, enum: AGENT_SESSION_RESOURCE_TYPES, required: true },
    resourceId: { type: String, required: true },
    ip: { type: String },
    previewUrl: { type: String },
    status: { type: String, enum: AGENT_SESSION_RESOURCE_STATUSES, default: 'active' },
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
