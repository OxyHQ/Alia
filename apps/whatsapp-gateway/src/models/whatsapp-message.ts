import mongoose, { Schema, Document } from 'mongoose';

export interface IWhatsAppMessage extends Document {
  oxyUserId: string;
  jid: string;
  messageId: string;
  fromMe: boolean;
  timestamp: number;
  text: string;
  pushName?: string;
  createdAt: Date;
}

const WhatsAppMessageSchema = new Schema<IWhatsAppMessage>(
  {
    oxyUserId: { type: String, required: true, index: true },
    jid: { type: String, required: true },
    messageId: { type: String, required: true },
    fromMe: { type: Boolean, default: false },
    timestamp: { type: Number, required: true },
    text: { type: String, default: '' },
    pushName: String,
  },
  { timestamps: true }
);

WhatsAppMessageSchema.index({ oxyUserId: 1, jid: 1, timestamp: -1 });
WhatsAppMessageSchema.index({ oxyUserId: 1, messageId: 1 }, { unique: true });

export const WhatsAppMessage = mongoose.model<IWhatsAppMessage>('WhatsAppMessage', WhatsAppMessageSchema);
