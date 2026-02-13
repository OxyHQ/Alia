import mongoose, { Schema, Document } from 'mongoose';

export interface ISignalMessage extends Document {
  sessionId: string;
  contactId: string;
  messageTimestamp: string;
  fromMe: boolean;
  timestamp: number;
  text: string;
  senderName?: string;
  createdAt: Date;
}

const SignalMessageSchema = new Schema<ISignalMessage>(
  {
    sessionId: { type: String, required: true, index: true },
    contactId: { type: String, required: true },
    messageTimestamp: { type: String, required: true },
    fromMe: { type: Boolean, default: false },
    timestamp: { type: Number, required: true },
    text: { type: String, default: '' },
    senderName: String,
  },
  { timestamps: true }
);

SignalMessageSchema.index({ sessionId: 1, contactId: 1, timestamp: -1 });
SignalMessageSchema.index({ sessionId: 1, messageTimestamp: 1 }, { unique: true });

export const SignalMessage = mongoose.model<ISignalMessage>('SignalMessage', SignalMessageSchema);
