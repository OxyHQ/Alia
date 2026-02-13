import mongoose, { Schema, Document } from 'mongoose';

export type SessionStatus = 'qr-pending' | 'connected' | 'disconnected' | 'logged-out' | 'failed';

export interface ITelegramSession extends Document {
  sessionId: string;
  oxyUserId: string;
  telegramUserId?: string;
  phoneNumber?: string;
  displayName?: string;
  status: SessionStatus;
  sessionString: string | null; // GramJS StringSession data
  lastConnected?: Date;
  lastDisconnected?: Date;
  lastQR?: string; // tg://login?token=... URL
  createdAt: Date;
  updatedAt: Date;
}

const TelegramSessionSchema = new Schema<ITelegramSession>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    oxyUserId: {
      type: String,
      required: true,
      index: true, // non-unique — multiple sessions per user
    },
    telegramUserId: {
      type: String,
    },
    phoneNumber: {
      type: String,
    },
    displayName: {
      type: String,
    },
    status: {
      type: String,
      enum: ['qr-pending', 'connected', 'disconnected', 'logged-out', 'failed'],
      default: 'qr-pending',
    },
    sessionString: {
      type: String,
      default: null,
    },
    lastConnected: {
      type: Date,
    },
    lastDisconnected: {
      type: Date,
    },
    lastQR: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

export const TelegramSession = mongoose.model<ITelegramSession>(
  'TelegramSession',
  TelegramSessionSchema
);
