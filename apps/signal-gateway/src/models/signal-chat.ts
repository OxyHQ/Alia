import mongoose, { Schema, Document } from 'mongoose';

export interface ISignalChat extends Document {
  sessionId: string;
  contactId: string;
  name?: string;
  unreadCount: number;
  lastMessageTimestamp?: number;
  chatType: 'direct' | 'group';
  updatedAt: Date;
}

const SignalChatSchema = new Schema<ISignalChat>(
  {
    sessionId: { type: String, required: true, index: true },
    contactId: { type: String, required: true },
    name: String,
    unreadCount: { type: Number, default: 0 },
    lastMessageTimestamp: Number,
    chatType: {
      type: String,
      enum: ['direct', 'group'],
      default: 'direct',
    },
  },
  { timestamps: true }
);

SignalChatSchema.index({ sessionId: 1, contactId: 1 }, { unique: true });
SignalChatSchema.index({ sessionId: 1, lastMessageTimestamp: -1 });

export const SignalChat = mongoose.model<ISignalChat>('SignalChat', SignalChatSchema);
