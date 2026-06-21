import mongoose, { Schema, Model, Document } from 'mongoose';

// ── Trigger types ──────────────────────────────────────────────────

export type TriggerType = 'schedule' | 'webhook' | 'integration_event' | 'agent_heartbeat';

export interface ITriggerSchedule {
  type: 'cron' | 'daily' | 'interval';
  cron?: string;              // Raw cron expression (e.g. "0 9 * * 1-5")
  time?: string;              // HH:MM for daily type
  days?: string[];            // Day names for daily type
  intervalMinutes?: number;   // For interval type
  timezone?: string;          // IANA timezone (e.g. "America/New_York")
}

export interface ITriggerWebhook {
  token: string;              // Unique token for the webhook URL
  secret?: string;            // Optional HMAC secret for payload verification
  allowedIps?: string[];      // Optional IP allowlist
}

export interface ITriggerIntegrationEvent {
  integrationId: mongoose.Types.ObjectId;
  service: string;            // e.g. "github", "linear", "notion"
  event: string;              // e.g. "push", "issue.created", "page.updated"
  filters?: Record<string, any>; // e.g. { repo: "my-repo", branch: "main" }
}

export interface ITriggerAction {
  prompt: string;             // Instructions for the AI when triggered
  agentId?: mongoose.Types.ObjectId;  // Specific agent to run
  roleId?: string;            // Skill/role to use
  useTools: boolean;          // Whether to give the AI tools
  notify?: boolean;           // Send notification of result to user
  channelId?: string;         // Channel to notify on (telegram, discord, etc.)
}

export interface ITrigger extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  type: TriggerType;
  enabled: boolean;

  // Configuration per type
  action: ITriggerAction;
  schedule?: ITriggerSchedule;
  webhook?: ITriggerWebhook;
  integrationEvent?: ITriggerIntegrationEvent;

  // Execution tracking
  lastTriggeredAt?: Date;
  nextTriggerAt?: Date;
  triggerCount: number;
  lastStatus?: 'success' | 'failed' | 'running';
  lastResult?: string;

  createdAt: Date;
  updatedAt: Date;
}

// ── Sub-schemas ────────────────────────────────────────────────────

const TriggerScheduleSchema = new Schema<ITriggerSchedule>({
  type: { type: String, required: true, enum: ['cron', 'daily', 'interval'] },
  cron: { type: String },
  time: { type: String },
  days: [{ type: String }],
  intervalMinutes: { type: Number },
  timezone: { type: String },
}, { _id: false });

const TriggerWebhookSchema = new Schema<ITriggerWebhook>({
  token: { type: String, required: true, index: true },
  secret: { type: String },
  allowedIps: [{ type: String }],
}, { _id: false });

const TriggerIntegrationEventSchema = new Schema<ITriggerIntegrationEvent>({
  integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', required: true },
  service: { type: String, required: true },
  event: { type: String, required: true },
  filters: { type: Schema.Types.Mixed },
}, { _id: false });

const TriggerActionSchema = new Schema<ITriggerAction>({
  prompt: { type: String, required: true },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent' },
  roleId: { type: String },
  useTools: { type: Boolean, default: false },
  notify: { type: Boolean, default: false },
  channelId: { type: String },
}, { _id: false });

// ── Main schema ────────────────────────────────────────────────────

const TriggerSchema = new Schema<ITrigger>({
  oxyUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  description: { type: String },
  type: {
    type: String,
    required: true,
    enum: ['schedule', 'webhook', 'integration_event', 'agent_heartbeat'],
    index: true,
  },
  enabled: { type: Boolean, default: true },

  action: { type: TriggerActionSchema, required: true },
  schedule: { type: TriggerScheduleSchema },
  webhook: { type: TriggerWebhookSchema },
  integrationEvent: { type: TriggerIntegrationEventSchema },

  lastTriggeredAt: { type: Date },
  nextTriggerAt: { type: Date },
  triggerCount: { type: Number, default: 0 },
  lastStatus: { type: String, enum: ['success', 'failed', 'running'] },
  lastResult: { type: String },
}, {
  timestamps: true,
});

// Compound indexes for efficient lookups
TriggerSchema.index({ oxyUserId: 1, type: 1 });
TriggerSchema.index({ 'webhook.token': 1 }, { sparse: true });
TriggerSchema.index({ 'integrationEvent.service': 1, 'integrationEvent.event': 1 }, { sparse: true });
TriggerSchema.index({ type: 1, enabled: 1 });

export const Trigger: Model<ITrigger> = mongoose.models.Trigger || mongoose.model<ITrigger>('Trigger', TriggerSchema);
