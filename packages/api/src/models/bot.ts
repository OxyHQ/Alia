import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IBot extends Document {
  platform: string;
  botId: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  status: 'active' | 'inactive' | 'error';
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

export const Bot: Model<IBot> = mongoose.model<IBot>('Bot', BotSchema);
