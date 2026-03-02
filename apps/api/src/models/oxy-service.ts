import mongoose, { Schema, Model, Document } from 'mongoose';

// ---------------------------------------------------------------------------
// Tool definition — describes a single operation Alia can perform on a service
// ---------------------------------------------------------------------------

export interface IOxyServiceToolEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // e.g., "/email/search" or "/email/messages/{messageId}"
  queryMapping?: Record<string, string>; // tool param → query param
  bodyMapping?: Record<string, string>; // tool param → body field
}

export interface IOxyServiceToolResultMapping {
  extract?: string; // Top-level field to pluck (e.g., "data")
  summarize?: string[]; // Fields to keep in AI summary
  maxChars?: number; // Per-tool truncation limit
}

export interface IOxyServiceTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema → Zod at runtime
  endpoint: IOxyServiceToolEndpoint;
  resultMapping?: IOxyServiceToolResultMapping;
  confirmBeforeExecute?: boolean; // e.g., true for sendEmail
}

// ---------------------------------------------------------------------------
// Event definition — describes events a service can push to Alia
// ---------------------------------------------------------------------------

export interface IOxyServiceEvent {
  name: string;
  description: string;
  action: 'notify' | 'context' | 'autonomous';
}

// ---------------------------------------------------------------------------
// Service manifest — one document per Oxy app / external service
// ---------------------------------------------------------------------------

export interface IOxyService extends Document {
  serviceId: string;
  displayName: string;
  description: string;
  version: string;
  baseUrl: string;
  icon?: string;
  status: 'active' | 'disabled';
  isFirstParty: boolean;
  webhookSecret?: string;
  tools: IOxyServiceTool[];
  events?: IOxyServiceEvent[];
  contextEndpoint?: string; // e.g., "/email/ai-context"
  createdAt: Date;
  updatedAt: Date;
}

const ToolEndpointSchema = new Schema(
  {
    method: { type: String, enum: ['GET', 'POST', 'PUT', 'DELETE'], required: true },
    path: { type: String, required: true },
    queryMapping: { type: Schema.Types.Mixed },
    bodyMapping: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ToolResultMappingSchema = new Schema(
  {
    extract: String,
    summarize: [String],
    maxChars: Number,
  },
  { _id: false },
);

const ToolSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    inputSchema: { type: Schema.Types.Mixed, required: true },
    endpoint: { type: ToolEndpointSchema, required: true },
    resultMapping: ToolResultMappingSchema,
    confirmBeforeExecute: { type: Boolean, default: false },
  },
  { _id: false },
);

const EventSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    action: { type: String, enum: ['notify', 'context', 'autonomous'], required: true },
  },
  { _id: false },
);

const OxyServiceSchema = new Schema<IOxyService>(
  {
    serviceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    displayName: { type: String, required: true },
    description: { type: String, required: true },
    version: { type: String, required: true },
    baseUrl: { type: String, required: true },
    icon: String,
    status: {
      type: String,
      enum: ['active', 'disabled'],
      default: 'active',
    },
    isFirstParty: { type: Boolean, default: false },
    webhookSecret: String,
    tools: { type: [ToolSchema], default: [] },
    events: { type: [EventSchema], default: [] },
    contextEndpoint: String,
  },
  { timestamps: true },
);

export const OxyService: Model<IOxyService> = mongoose.model<IOxyService>('OxyService', OxyServiceSchema);
