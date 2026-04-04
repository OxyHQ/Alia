import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IBotUser extends Document {
  botId: mongoose.Types.ObjectId;
  platform: string;
  platformUserId: string;
  chatId: string;
  oxyUserId?: mongoose.Types.ObjectId;
  isLinked: boolean;
  linkedAt?: Date;
  username?: string;
  displayName?: string;
  authToken?: string;
  authTokenExpiry?: Date;
  authTokenMode?: 'link' | 'signin';
  conversationId?: string;
  preferredModel?: string;
  metadata: Record<string, any>;
}

const BotUserSchema = new Schema<IBotUser>(
  {
    botId: {
      type: Schema.Types.ObjectId,
      ref: 'Bot',
      required: true,
    },
    platform: {
      type: String,
      required: true,
    },
    platformUserId: {
      type: String,
      required: true,
    },
    chatId: {
      type: String,
      required: true,
    },
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    isLinked: {
      type: Boolean,
      default: false,
    },
    linkedAt: Date,
    username: String,
    displayName: String,
    authToken: String,
    authTokenExpiry: Date,
    authTokenMode: {
      type: String,
      enum: ['link', 'signin'],
    },
    conversationId: String,
    preferredModel: String,
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

BotUserSchema.index({ botId: 1, platformUserId: 1 }, { unique: true });
BotUserSchema.index({ authToken: 1, authTokenExpiry: 1 });

export const BotUser: Model<IBotUser> = mongoose.model<IBotUser>('BotUser', BotUserSchema);
