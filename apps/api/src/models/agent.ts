import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IAgentPermissions {
  /** Allow file read/write operations in sandbox */
  filesystem: boolean;
  /** Allow web browsing and search */
  network: boolean;
  /** Allow shell command execution */
  shell: boolean;
  /** Allow sending messages via Telegram/WhatsApp/Email */
  communications: boolean;
  /** Allow access to MCP tools */
  mcp_servers: boolean;
  /** Allow hiring sub-agents */
  delegation: boolean;
}

export interface IAgentSoul {
  vibe: string[];
  expertise: string[];
  worldview: string[];
  currentFocus: string[];
  interactionCount: number;
  lastEvolvedAt: Date | null;
}

export const AGENT_ARCHETYPES = ['general', 'qa', 'task_router', 'status_update'] as const;
export type AgentArchetype = (typeof AGENT_ARCHETYPES)[number];

export interface IArchetypeConfig {
  // Q&A
  knowledgeSources?: { integrations?: string[]; mcpServers?: string[]; oxyServices?: string[] };
  citeSources?: boolean;
  // Task Router
  inboundChannels?: string[];
  routingRules?: Array<{
    condition: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    assignTo: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
  }>;
  defaultAssignee?: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
  escalationTimeoutMinutes?: number;
  // Status Update
  dataSources?: { integrations?: string[]; mcpServers?: string[]; oxyServices?: string[] };
  reportTemplate?: string;
  reportFormat?: 'markdown' | 'html' | 'plain';
  deliveryChannels?: string[];
  schedule?: {
    type: 'daily' | 'interval' | 'cron';
    time?: string;
    days?: string[];
    intervalMinutes?: number;
    cron?: string;
  };
  compareWithPrevious?: boolean;
}

export interface IAgent extends Document {
  name: string;
  handle: string;
  avatar: string | null;
  tagline: string;
  description: string;
  author: mongoose.Types.ObjectId;
  authorName: string;
  authorVerified: boolean;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  price: number | null;
  capabilities: string[];
  skills: mongoose.Types.ObjectId[];
  knowledge: mongoose.Types.ObjectId[];
  isVerified: boolean;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  creditBalance: number;
  allowHiring: boolean;
  systemPrompt?: string;
  preferredImage?: string;
  allowedModels: string[];
  scheduleInterval?: number;
  lastScheduledCheck?: Date;
  accessories: Array<{
    accessoryId: string;
    position: { x: number; y: number; scale: number; rotation: number };
  }>;
  permissions?: IAgentPermissions;
  soul?: IAgentSoul;
  archetype: AgentArchetype;
  archetypeConfig?: IArchetypeConfig;
  createdAt: Date;
  updatedAt: Date;
}

const AgentSchema = new Schema<IAgent>({
  name: { type: String, required: true },
  handle: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  avatar: { type: String, default: null },
  tagline: { type: String, required: true },
  description: { type: String, required: true },
  author: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  authorName: { type: String, required: true },
  authorVerified: { type: Boolean, default: false },
  category: { type: String, required: true, index: true },
  tags: [{ type: String }],
  rating: { type: Number, default: 0, min: 0, max: 5 },
  reviewCount: { type: Number, default: 0 },
  usageCount: { type: Number, default: 0 },
  hireCount: { type: Number, default: 0 },
  price: { type: Number, default: null },
  capabilities: [{ type: String }],
  skills: [{
    type: Schema.Types.ObjectId,
    ref: 'Skill',
  }],
  knowledge: [{
    type: Schema.Types.ObjectId,
    ref: 'LibraryFile',
  }],
  isVerified: { type: Boolean, default: false },
  isFeatured: { type: Boolean, default: false },
  isTrending: { type: Boolean, default: false },
  isPublished: { type: Boolean, default: true },
  status: {
    type: String,
    enum: ['active', 'idle', 'offline'],
    default: 'active',
  },
  creditBalance: { type: Number, default: 0 },
  allowHiring: { type: Boolean, default: false },
  accessories: [{
    accessoryId: { type: String, required: true },
    position: {
      x: { type: Number, default: 0.5 },
      y: { type: Number, default: 0.5 },
      scale: { type: Number, default: 1 },
      rotation: { type: Number, default: 0 },
    },
  }],
  systemPrompt: { type: String },
  preferredImage: { type: String },
  allowedModels: {
    type: [String],
    default: ['clarity-v1', 'clarity-pro'],
  },
  scheduleInterval: { type: Number },
  lastScheduledCheck: { type: Date },
  permissions: {
    type: {
      filesystem: { type: Boolean, default: true },
      network: { type: Boolean, default: true },
      shell: { type: Boolean, default: true },
      communications: { type: Boolean, default: true },
      mcp_servers: { type: Boolean, default: true },
      delegation: { type: Boolean, default: true },
    },
    default: undefined,  // undefined = all allowed (backward compatible)
  },
  soul: {
    type: {
      vibe: { type: [String], default: [] },
      expertise: { type: [String], default: [] },
      worldview: { type: [String], default: [] },
      currentFocus: { type: [String], default: [] },
      interactionCount: { type: Number, default: 0 },
      lastEvolvedAt: { type: Date, default: null },
    },
    default: undefined,
  },
  archetype: {
    type: String,
    enum: AGENT_ARCHETYPES,
    default: 'general',
    index: true,
  },
  archetypeConfig: { type: Schema.Types.Mixed, default: undefined },
}, {
  timestamps: true,
});

AgentSchema.index({ isPublished: 1, isFeatured: -1, createdAt: -1 });
AgentSchema.index({ category: 1, isPublished: 1 });

export const Agent: Model<IAgent> = mongoose.models.Agent || mongoose.model<IAgent>('Agent', AgentSchema);
