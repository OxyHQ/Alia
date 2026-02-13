import mongoose, { Schema, Document } from 'mongoose';

export interface IWhatsAppChat extends Document {
  sessionId: string;
  oxyUserId: string;
  jid: string;
  name?: string;
  unreadCount: number;
  conversationTimestamp?: number;
  updatedAt: Date;
}

const WhatsAppChatSchema = new Schema<IWhatsAppChat>(
  {
    sessionId: { type: String, required: true, index: true },
    oxyUserId: { type: String, required: true, index: true },
    jid: { type: String, required: true },
    name: String,
    unreadCount: { type: Number, default: 0 },
    conversationTimestamp: Number,
  },
  { timestamps: true }
);

WhatsAppChatSchema.index({ sessionId: 1, jid: 1 }, { unique: true });
WhatsAppChatSchema.index({ sessionId: 1, conversationTimestamp: -1 });

export const WhatsAppChat = mongoose.model<IWhatsAppChat>('WhatsAppChat', WhatsAppChatSchema);
