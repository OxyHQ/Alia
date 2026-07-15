import mongoose, { Schema, Model, Document } from 'mongoose';
import { encrypt, decrypt } from '../lib/crypto-utils.js';

export interface IConnectedAccount extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  platform: string;
  accountId: string;
  displayName?: string;
  phoneNumber?: string;
  email?: string;
  avatarUrl?: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'expired';
  statusMessage?: string;
  sessionId?: string;
  capabilities: string[];
  autoReply: boolean;
  autoReplyAgentId?: mongoose.Types.ObjectId;
  customContext?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedSkillIds?: mongoose.Types.ObjectId[];
  oauthTokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    scope: string;
  };
  metadata: Record<string, any>;
  lastActiveAt?: Date;
  connectedAt?: Date;
}

const ConnectedAccountSchema = new Schema<IConnectedAccount>(
  {
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    platform: {
      type: String,
      required: true,
    },
    accountId: {
      type: String,
      required: true,
    },
    displayName: String,
    phoneNumber: String,
    email: String,
    avatarUrl: String,
    status: {
      type: String,
      enum: ['connecting', 'connected', 'disconnected', 'error', 'expired'],
      default: 'connecting',
    },
    statusMessage: String,
    sessionId: String,
    capabilities: {
      type: [String],
      default: [],
    },
    autoReply: {
      type: Boolean,
      default: false,
    },
    autoReplyAgentId: {
      type: Schema.Types.ObjectId,
      ref: 'Agent',
    },
    customContext: String,
    allowedTools: [String],
    blockedTools: [String],
    allowedSkillIds: [{ type: Schema.Types.ObjectId, ref: 'Skill' }],
    oauthTokens: {
      type: new Schema(
        {
          accessToken: { type: String, required: true, set: encrypt, get: decrypt },
          refreshToken: { type: String, required: false, set: encrypt, get: decrypt },
          expiresAt: { type: Date, required: false },
          scope: { type: String, required: true },
        },
        { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
      ),
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    lastActiveAt: Date,
    connectedAt: Date,
  },
  {
    timestamps: true,
  },
);

ConnectedAccountSchema.index({ oxyUserId: 1, platform: 1 });
ConnectedAccountSchema.index({ oxyUserId: 1 });
ConnectedAccountSchema.index({ sessionId: 1 });

export const ConnectedAccount: Model<IConnectedAccount> = mongoose.model<IConnectedAccount>(
  'ConnectedAccount',
  ConnectedAccountSchema,
);
