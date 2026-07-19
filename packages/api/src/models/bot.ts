import mongoose, { Schema, Model, Document } from 'mongoose';
import { encrypt, decrypt } from '../lib/crypto-utils.js';

export interface IBot extends Document {
  platform: string;
  botId: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  status: 'active' | 'inactive' | 'error';
  /** Owner of a user-registered bot. Absent for the system/global env-based bot. */
  userId?: mongoose.Types.ObjectId;
  /** The bot's platform token (e.g. Telegram bot token), encrypted at rest. `select: false`. */
  botToken?: string;
  /** Per-bot routing secret the platform echoes on inbound updates. Plaintext, `select: false`. */
  webhookSecret?: string;
  agentId?: mongoose.Types.ObjectId;
  defaultModel?: string;
  platformConfig: {
    webhookUrl?: string;
    publicKey?: string;
  };
  totalUsers: number;
  totalMessages: number;
  lastMessageAt?: Date;
}

const BotSchema = new Schema<IBot>(
  {
    platform: {
      type: String,
      required: true,
    },
    botId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    username: String,
    avatarUrl: String,
    status: {
      type: String,
      enum: ['active', 'inactive', 'error'],
      default: 'active',
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    botToken: {
      type: String,
      select: false,
      set: (v: string | undefined) => (v ? encrypt(v) : v),
      get: (v: string | undefined) => (v ? decrypt(v) : v),
    },
    webhookSecret: {
      type: String,
      select: false,
    },
    agentId: {
      type: Schema.Types.ObjectId,
      ref: 'Agent',
    },
    defaultModel: String,
    platformConfig: {
      type: new Schema(
        {
          webhookUrl: String,
          publicKey: String,
        },
        { _id: false },
      ),
      default: {},
    },
    totalUsers: {
      type: Number,
      default: 0,
    },
    totalMessages: {
      type: Number,
      default: 0,
    },
    lastMessageAt: Date,
  },
  {
    timestamps: true,
  },
);

BotSchema.index({ platform: 1, botId: 1 }, { unique: true });
BotSchema.index({ webhookSecret: 1 }, { sparse: true });
BotSchema.index({ userId: 1 }, { sparse: true });

export const Bot: Model<IBot> = mongoose.model<IBot>('Bot', BotSchema);
