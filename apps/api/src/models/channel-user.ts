import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IChannelUser extends Document {
  channelType: string;
  channelUserId: string;
  chatId: string;
  oxyUserId?: mongoose.Types.ObjectId;
  username?: string;
  displayName?: string;
  isAuthenticated: boolean;
  linkedAt?: Date;
  authToken?: string;
  authTokenExpiry?: Date;
  authTokenMode?: 'link' | 'signin';
  conversationId?: string;
  preferredModel?: string;
  metadata: Record<string, any>;
}

const ChannelUserSchema = new Schema<IChannelUser>(
  {
    channelType: {
      type: String,
      required: true,
      index: true,
    },
    channelUserId: {
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
    username: String,
    displayName: String,
    isAuthenticated: {
      type: Boolean,
      default: false,
    },
    linkedAt: Date,
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
  }
);

ChannelUserSchema.index({ channelType: 1, channelUserId: 1 }, { unique: true });
ChannelUserSchema.index({ channelType: 1, oxyUserId: 1 });
ChannelUserSchema.index({ authToken: 1, authTokenExpiry: 1 });

export const ChannelUser: Model<IChannelUser> = mongoose.model<IChannelUser>('ChannelUser', ChannelUserSchema);
