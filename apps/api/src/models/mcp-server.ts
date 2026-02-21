import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IMcpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface IMcpServerResource {
  uri: string;
  name: string;
  description?: string;
}

export interface IMcpServer extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  source: 'registry' | 'custom';
  registryId?: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  runtime: 'server' | 'local';
  config: {
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
  status: 'installed' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  tools: IMcpServerTool[];
  resources?: IMcpServerResource[];
  enabled: boolean;
}

const McpServerToolSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    inputSchema: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const McpServerResourceSchema = new Schema(
  {
    uri: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
  },
  { _id: false },
);

const McpServerSchema = new Schema<IMcpServer>(
  {
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    displayName: {
      type: String,
      required: true,
    },
    description: String,
    icon: String,
    source: {
      type: String,
      enum: ['registry', 'custom'],
      default: 'registry',
    },
    registryId: String,
    transport: {
      type: String,
      enum: ['stdio', 'sse', 'streamable-http'],
      required: true,
    },
    runtime: {
      type: String,
      enum: ['server', 'local'],
      default: 'server',
    },
    config: {
      type: new Schema(
        {
          command: String,
          args: [String],
          url: String,
          headers: { type: Map, of: String },
          env: { type: Map, of: String },
        },
        { _id: false },
      ),
      default: {},
    },
    status: {
      type: String,
      enum: ['installed', 'running', 'stopped', 'error'],
      default: 'installed',
    },
    statusMessage: String,
    tools: {
      type: [McpServerToolSchema],
      default: [],
    },
    resources: [McpServerResourceSchema],
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

McpServerSchema.index({ oxyUserId: 1 });
McpServerSchema.index({ oxyUserId: 1, name: 1 }, { unique: true });

export const McpServer: Model<IMcpServer> = mongoose.model<IMcpServer>('McpServer', McpServerSchema);
