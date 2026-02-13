import mongoose, { Schema, Document } from 'mongoose';

export interface ITelegramMessage extends Document {
  sessionId: string;
  chatId: string;
  messageId: string;
  fromMe: boolean;
  timestamp: number;
  text: string;
  senderName?: string;
  createdAt: Date;
}

const TelegramMessageSchema = new Schema<ITelegramMessage>(
  {
    sessionId: { type: String, required: true },
    chatId: { type: String, required: true },
    messageId: { type: String, required: true },
    fromMe: { type: Boolean, default: false },
    timestamp: { type: Number, required: true },
    text: { type: String, default: '' },
    senderName: String,
  },
  { timestamps: true }
);

TelegramMessageSchema.index({ sessionId: 1, chatId: 1, timestamp: -1 });
TelegramMessageSchema.index({ sessionId: 1, messageId: 1 }, { unique: true });

export const TelegramMessage = mongoose.model<ITelegramMessage>(
  'TelegramMessage',
  TelegramMessageSchema
);
