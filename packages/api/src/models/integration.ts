import mongoose, { Schema, Model, Document } from 'mongoose';
import { encrypt, decrypt } from '../lib/crypto-utils.js';

export interface IIntegration extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  service: string;
  displayName: string;
  oauthTokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    scope: string;
    tokenType: string;
  };
  accountId?: string;
  accountName?: string;
  avatarUrl?: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  enabled: boolean;
  metadata: Record<string, any>;
  connectedAt: Date;
  lastUsedAt?: Date;
}

const IntegrationSchema = new Schema<IIntegration>(
  {
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    service: {
      type: String,
      required: true,
    },
    displayName: {
      type: String,
      required: true,
    },
    oauthTokens: {
      type: new Schema(
        {
          accessToken: { type: String, required: true, set: encrypt, get: decrypt },
          refreshToken: { type: String, set: (v: string | undefined) => v ? encrypt(v) : v, get: (v: string | undefined) => v ? decrypt(v) : v },
          expiresAt: Date,
          scope: { type: String, required: true },
          tokenType: { type: String, required: true },
        },
        { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
      ),
      required: true,
    },
    accountId: String,
    accountName: String,
    avatarUrl: String,
    status: {
      type: String,
      enum: ['active', 'expired', 'revoked', 'error'],
      default: 'active',
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    connectedAt: {
      type: Date,
      default: Date.now,
    },
    lastUsedAt: Date,
  },
  {
    timestamps: true,
  },
);

IntegrationSchema.index({ oxyUserId: 1 });
IntegrationSchema.index({ oxyUserId: 1, service: 1 });

export const Integration: Model<IIntegration> = mongoose.model<IIntegration>('Integration', IntegrationSchema);
