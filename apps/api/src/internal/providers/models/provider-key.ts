import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';
import { log } from '../../../lib/logger.js';
import { PROVIDER_NAMES } from '../lib/provider-names.js';

export interface IRateLimit {
  rps?: number;  // Requests per second
  rpm?: number;  // Requests per minute
  rph?: number;  // Requests per hour
  rpd?: number;  // Requests per day
  tps?: number;  // Tokens per second
  tpm?: number;  // Tokens per minute
  tph?: number;  // Tokens per hour
  tpd?: number;  // Tokens per day
}

export interface IProviderKey extends Document {
  // Identification
  name: string;
  provider: string;
  environment: string;

  // Security
  keyHash: string;
  keyPrefix: string;
  key?: string;

  // Rate Limits
  rateLimit: IRateLimit;

  // Status & Metadata
  isActive: boolean;
  isPaid: boolean;
  tier: string;

  // Priority Management (Dynamic Rotation)
  currentPriority: number;      // Dynamic priority (changes on failure)
  originalPriority: number;     // Original priority to restore on success

  // Credit/Spending Limits
  creditLimitUSD?: number | null;  // Max spend for this key (null = unlimited)
  spentUSD: number;                // Total USD spent through this key

  // Usage Tracking
  lastUsedAt?: Date;
  lastSuccessAt?: Date;
  totalRequests: number;
  totalTokens: number;
  successCount: number;

  // Failure Tracking
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureAt?: Date;
  lastFailureReason?: string;
  cooldownUntil?: Date | null;
  rateLimitResetMs?: number | null; // Fixed cooldown for rate_limit errors (e.g. 60000 for 1 min)

  // Archiving (only after many total failures)
  maxTotalFailures: number;     // Archive after X total failures (default: 100)
  isArchived: boolean;
  archivedAt?: Date;
  archivedReason?: string;

  // Key Rotation
  rotatedAt?: Date;
  expiresAt?: Date;
  rotationSchedule?: string;

  // Ownership (optional - for multi-tenant)
  ownerId?: string;
  organizationId?: mongoose.Types.ObjectId;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  validateKey(key: string): boolean;
  updateUsage(tokens: number): Promise<void>;
  recordFailure(reason: string, maxPriority: number): Promise<void>;
  recordSuccess(): Promise<void>;
  isAvailable(): boolean;
}

const ProviderKeySchema = new Schema<IProviderKey>(
  {
    name: {
      type: String,
      required: true,
      maxlength: 200,
    },
    provider: {
      type: String,
      required: true,
      enum: [...PROVIDER_NAMES],
      index: true,
    },
    environment: {
      type: String,
      required: true,
      enum: ['production', 'staging', 'development'],
      default: 'production',
      index: true,
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
    },
    keyPrefix: {
      type: String,
      required: true,
      maxlength: 20,
    },
    key: {
      type: String,
      required: false,
    },
    rateLimit: {
      rps: { type: Number },
      rpm: { type: Number },
      rph: { type: Number },
      rpd: { type: Number },
      tps: { type: Number },
      tpm: { type: Number },
      tph: { type: Number },
      tpd: { type: Number },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    tier: {
      type: String,
      enum: ['free', 'freemium', 'paid', 'enterprise'],
      default: 'free',
    },
    currentPriority: {
      type: Number,
      default: 10,
      min: 1,
      max: 1000,
    },
    originalPriority: {
      type: Number,
      default: 10,
      min: 1,
      max: 100,
    },
    creditLimitUSD: {
      type: Number,
      default: null,
    },
    spentUSD: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
    },
    lastSuccessAt: {
      type: Date,
    },
    totalRequests: {
      type: Number,
      default: 0,
    },
    totalTokens: {
      type: Number,
      default: 0,
    },
    successCount: {
      type: Number,
      default: 0,
    },
    consecutiveFailures: {
      type: Number,
      default: 0,
    },
    totalFailures: {
      type: Number,
      default: 0,
    },
    lastFailureAt: {
      type: Date,
    },
    lastFailureReason: {
      type: String,
      maxlength: 500,
    },
    cooldownUntil: {
      type: Date,
      default: null,
    },
    rateLimitResetMs: {
      type: Number,
      default: null,
    },
    maxTotalFailures: {
      type: Number,
      default: 100,
      min: 10,
      max: 1000,
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    archivedAt: {
      type: Date,
    },
    archivedReason: {
      type: String,
      maxlength: 500,
    },
    rotatedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
    },
    rotationSchedule: {
      type: String,
      enum: ['manual', 'monthly', 'quarterly', 'yearly'],
      default: 'manual',
    },
    ownerId: {
      type: String,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
ProviderKeySchema.index({ provider: 1, isActive: 1, isArchived: 1, currentPriority: 1 });
ProviderKeySchema.index({ environment: 1, isActive: 1 });
ProviderKeySchema.index({ ownerId: 1 }, { sparse: true });
ProviderKeySchema.index({ organizationId: 1 }, { sparse: true });

// Methods
ProviderKeySchema.methods.validateKey = function (key: string): boolean {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return hash === this.keyHash;
};

ProviderKeySchema.methods.updateUsage = async function (tokens: number): Promise<void> {
  this.lastUsedAt = new Date();
  this.totalRequests += 1;
  this.totalTokens += tokens;
  await this.save();
};

/**
 * Record a failure - moves key to last priority (end of queue)
 * @param reason Failure reason
 * @param maxPriority Maximum priority value among all keys (to set as last)
 */
ProviderKeySchema.methods.recordFailure = async function (
  reason: string,
  maxPriority: number = 999
): Promise<void> {
  // Rate limits are transient — the key works fine, we just hit quota.
  // Don't count toward consecutiveFailures or totalFailures (avoids archival).
  const isRateLimit = /rate.?limit|429|RESOURCE_EXHAUSTED|quota/i.test(reason);

  if (!isRateLimit) {
    this.consecutiveFailures += 1;
    this.totalFailures += 1;
  }

  this.lastFailureAt = new Date();
  this.lastFailureReason = reason.substring(0, 500);

  // Move to last priority (end of queue) so other keys get tried first
  this.currentPriority = maxPriority + 1;

  log.keys.warn({ keyPrefix: this.keyPrefix, provider: this.provider, priority: this.currentPriority, reason: reason.substring(0, 50), isRateLimit }, 'Key moved to last priority after failure');

  // Check if we should archive (too many total failures)
  if (this.totalFailures >= this.maxTotalFailures) {
    this.isArchived = true;
    this.isActive = false;
    this.archivedAt = new Date();
    this.archivedReason = `Archived after ${this.totalFailures} total failures`;
    log.keys.error({ keyPrefix: this.keyPrefix, provider: this.provider, totalFailures: this.totalFailures }, 'Key archived after too many failures');
  }

  await this.save();
};

/**
 * Record a success - restores key to original priority
 */
ProviderKeySchema.methods.recordSuccess = async function (): Promise<void> {
  const wasDeprioritized = this.currentPriority !== this.originalPriority;

  this.consecutiveFailures = 0;
  this.successCount += 1;
  this.lastSuccessAt = new Date();

  // Restore to original priority
  if (wasDeprioritized) {
    this.currentPriority = this.originalPriority;
    log.keys.info({ keyPrefix: this.keyPrefix, provider: this.provider, priority: this.currentPriority }, 'Key restored to original priority after success');
  }

  // Reactivate if it was inactive (but not if archived)
  if (!this.isArchived && !this.isActive) {
    this.isActive = true;
    log.keys.info({ keyPrefix: this.keyPrefix, provider: this.provider }, 'Key reactivated');
  }

  await this.save();
};

/**
 * Check if key is available for use
 */
ProviderKeySchema.methods.isAvailable = function (): boolean {
  // Archived keys are never available
  if (this.isArchived) {
    return false;
  }

  // Otherwise, check if active
  return this.isActive;
};

// Static methods
ProviderKeySchema.statics.hashKey = function (key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
};

ProviderKeySchema.statics.getKeyPrefix = function (key: string): string {
  return key.substring(0, Math.min(8, key.length)) + '...';
};

export const ProviderKey = (mongoose.models.ProviderKey || mongoose.model<IProviderKey>('ProviderKey', ProviderKeySchema)) as mongoose.Model<IProviderKey>;
