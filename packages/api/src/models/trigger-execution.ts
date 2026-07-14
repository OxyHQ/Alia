import mongoose, { Schema, Model, Document } from 'mongoose';
import type { TriggerType } from './trigger';

export interface ITriggerExecution extends Document {
  triggerId: mongoose.Types.ObjectId;
  oxyUserId: mongoose.Types.ObjectId;
  status: 'running' | 'success' | 'failed';
  triggerType: TriggerType | 'manual';

  // Input context
  input?: {
    event?: string;           // Event name for integration triggers
    payload?: Record<string, any>; // Webhook/event payload
    source?: string;          // What initiated this (e.g. "cron", "webhook", "manual", "github")
  };

  // Output
  result?: string;            // AI response text
  toolCalls?: Array<{
    tool: string;
    args: Record<string, any>;
  }>;

  // Usage
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  durationMs?: number;

  startedAt: Date;
  completedAt?: Date;
}

const TriggerExecutionSchema = new Schema<ITriggerExecution>({
  triggerId: {
    type: Schema.Types.ObjectId,
    ref: 'Trigger',
    required: true,
    index: true,
  },
  oxyUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['running', 'success', 'failed'],
  },
  triggerType: {
    type: String,
    required: true,
    enum: ['schedule', 'webhook', 'integration_event', 'agent_heartbeat', 'manual'],
  },

  input: {
    event: { type: String },
    payload: { type: Schema.Types.Mixed },
    source: { type: String },
  },

  result: { type: String },
  toolCalls: [{
    tool: { type: String },
    args: { type: Schema.Types.Mixed },
  }],

  tokens: {
    prompt: { type: Number },
    completion: { type: Number },
    total: { type: Number },
  },
  durationMs: { type: Number },

  startedAt: { type: Date, required: true, default: Date.now },
  completedAt: { type: Date },
}, {
  timestamps: false,
});

// TTL index: auto-delete executions older than 30 days
TriggerExecutionSchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
// Query by trigger + time
TriggerExecutionSchema.index({ triggerId: 1, startedAt: -1 });

export const TriggerExecution: Model<ITriggerExecution> = mongoose.models.TriggerExecution || mongoose.model<ITriggerExecution>('TriggerExecution', TriggerExecutionSchema);
