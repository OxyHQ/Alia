import mongoose, { Schema, Document } from 'mongoose';

export interface IApiKeyUsage extends Document {
  apiKeyId: mongoose.Types.ObjectId;
  oxyUserId: mongoose.Types.ObjectId;
  appId: mongoose.Types.ObjectId;
  endpoint: string;
  method: string;
  statusCode: number;
  tokensUsed?: number;
  creditsUsed?: number;
  responseTime?: number; // in milliseconds
  userAgent?: string;
  ipAddress?: string;
  timestamp: Date;
}

const ApiKeyUsageSchema = new Schema<IApiKeyUsage>(
  {
    apiKeyId: {
      type: Schema.Types.ObjectId,
      ref: 'DeveloperApiKey',
      required: true,
      index: true,
    },
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    appId: {
      type: Schema.Types.ObjectId,
      ref: 'DeveloperApp',
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      required: true,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
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
    ipAddress: {
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
ApiKeyUsageSchema.index({ appId: 1, timestamp: -1 });

// TTL index to auto-delete old usage data after 90 days
ApiKeyUsageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const ApiKeyUsage = mongoose.model<IApiKeyUsage>('ApiKeyUsage', ApiKeyUsageSchema);

export default ApiKeyUsage;
