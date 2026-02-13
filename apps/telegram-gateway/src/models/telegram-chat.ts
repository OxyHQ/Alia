import mongoose, { Schema, Document } from 'mongoose';

export interface ITelegramChat extends Document {
  sessionId: string;
  chatId: string;
  name?: string;
  unreadCount: number;
  lastMessageTimestamp?: number;
  chatType: 'user' | 'group' | 'channel';
  updatedAt: Date;
}

const TelegramChatSchema = new Schema<ITelegramChat>(
  {
    sessionId: { type: String, required: true, index: true },
    chatId: { type: String, required: true },
    name: String,
    unreadCount: { type: Number, default: 0 },
    lastMessageTimestamp: Number,
    chatType: {
      type: String,
      enum: ['user', 'group', 'channel'],
      default: 'user',
    },
  },
  { timestamps: true }
);

TelegramChatSchema.index({ sessionId: 1, chatId: 1 }, { unique: true });
TelegramChatSchema.index({ sessionId: 1, lastMessageTimestamp: -1 });

export const TelegramChat = mongoose.model<ITelegramChat>('TelegramChat', TelegramChatSchema);
