import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

export interface IRateLimitConfig {
  requestsPerMinute: number | null;  // null = unlimited
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
}

export interface IDeveloperApiKey extends Document {
  oxyUserId: string;
  appId: mongoose.Types.ObjectId;
  name: string;
  keyHash: string;
  keyPrefix: string; // First 8 chars for display (e.g., "alia_sk_12345678")
  scopes: string[];
  expiresAt?: Date;
  lastUsedAt?: Date;
  isActive: boolean;
  rateLimit: IRateLimitConfig;
  createdAt: Date;
  updatedAt: Date;

  // Methods
  validateKey(key: string): boolean;
}

const DeveloperApiKeySchema = new Schema<IDeveloperApiKey>(
  {
    oxyUserId: {
      type: String,
      required: true,
      index: true,
    },
    appId: {
      type: Schema.Types.ObjectId,
      ref: 'DeveloperApp',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
    },
    keyPrefix: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      default: ['chat:read', 'chat:write'],
      enum: [
        'chat:read',
        'chat:write',
        'models:read',
        'conversations:read',
        'conversations:write',
        'conversations:delete',
        'memory:read',
        'memory:write',
      ],
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    rateLimit: {
      type: {
        requestsPerMinute: { type: Number, default: null },
        requestsPerDay: { type: Number, default: 1000 },
        tokensPerMinute: { type: Number, default: null },
        tokensPerDay: { type: Number, default: null },
      },
      default: {
        requestsPerMinute: null,  // unlimited by default
        requestsPerDay: 1000,     // 1000 requests/day default
        tokensPerMinute: null,    // unlimited by default
        tokensPerDay: null,       // unlimited by default
      },
    },
  },
  {
    timestamps: true,
  }
);

// Indexes (keyHash is already indexed via unique: true)
DeveloperApiKeySchema.index({ oxyUserId: 1, isActive: 1 });
DeveloperApiKeySchema.index({ appId: 1, isActive: 1 });

// Method to validate API key
DeveloperApiKeySchema.methods.validateKey = function (key: string): boolean {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return hash === this.keyHash;
};

// Static method to generate a new API key
DeveloperApiKeySchema.statics.generateKey = function (): string {
  // Generate a random 32-byte key and encode as base64
  const randomBytes = crypto.randomBytes(32);
  const key = randomBytes.toString('base64url'); // URL-safe base64
  return `alia_sk_${key}`;
};

// Static method to hash a key
DeveloperApiKeySchema.statics.hashKey = function (key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
};

const DeveloperApiKey = mongoose.model<IDeveloperApiKey>('DeveloperApiKey', DeveloperApiKeySchema);

export default DeveloperApiKey;
