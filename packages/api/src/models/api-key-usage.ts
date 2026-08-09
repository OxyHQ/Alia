import mongoose, { Schema, Document } from 'mongoose';

/** How the caller authenticated. Drives which rate-limit budget the call spends. */
export const API_KEY_USAGE_AUTH_TYPES = ['api_key', 'session', 'internal'] as const;
export type ApiKeyUsageAuthType = (typeof API_KEY_USAGE_AUTH_TYPES)[number];

/** The HTTP methods this API exposes. */
export const API_KEY_USAGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiKeyUsageMethod = (typeof API_KEY_USAGE_METHODS)[number];

export interface IApiKeyUsage extends Document {
  apiKeyId?: mongoose.Types.ObjectId;  // Optional: null for session-based auth
  oxyUserId: string;
  appId?: mongoose.Types.ObjectId;  // Optional: null for session-based auth
  endpoint: string;
  method: string;
  statusCode: number;
  tokensUsed?: number;
  creditsUsed?: number;
  responseTime?: number; // in milliseconds
  userAgent?: string;
  timestamp: Date;
  authType: 'api_key' | 'session' | 'internal';  // Track auth type for rate limiting
  serviceApp?: string;  // Service app name for internal auth
}

const ApiKeyUsageSchema = new Schema<IApiKeyUsage>(
  {
    apiKeyId: {
      type: Schema.Types.ObjectId,
      ref: 'DeveloperApiKey',
      required: false,
    },
    oxyUserId: {
      type: String,
      required: true,
    },
    appId: {
      type: Schema.Types.ObjectId,
      ref: 'DeveloperApp',
      required: false,
    },
    authType: {
      type: String,
      enum: [...API_KEY_USAGE_AUTH_TYPES],
      default: 'api_key',
    },
    serviceApp: {
      type: String,
    },
    endpoint: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      required: true,
      enum: [...API_KEY_USAGE_METHODS],
    },
    statusCode: {
      type: Number,
      required: true,
    },
    tokensUsed: {
      type: Number,
      default: 0,
    },
    creditsUsed: {
      type: Number,
      default: 0,
    },
    responseTime: {
      type: Number,
    },
    userAgent: {
      type: String,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

// Compound indexes for efficient queries
ApiKeyUsageSchema.index({ apiKeyId: 1, timestamp: -1 });
ApiKeyUsageSchema.index({ oxyUserId: 1, timestamp: -1 });
ApiKeyUsageSchema.index({ oxyUserId: 1, authType: 1, timestamp: -1 });
ApiKeyUsageSchema.index({ appId: 1, timestamp: -1 });

// TTL index to auto-delete old usage data after 90 days
ApiKeyUsageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const ApiKeyUsage = mongoose.model<IApiKeyUsage>('ApiKeyUsage', ApiKeyUsageSchema);

export default ApiKeyUsage;
