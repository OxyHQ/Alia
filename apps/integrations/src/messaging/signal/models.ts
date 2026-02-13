import mongoose, { Schema, Document } from 'mongoose';

// ──────────────────────────────────────────────
// Signal Session
// ──────────────────────────────────────────────

export type SessionStatus = 'linking' | 'connected' | 'disconnected' | 'unlinked' | 'failed';

export interface ISignalSession extends Document {
  sessionId: string;
  oxyUserId: string;
  phoneNumber?: string;
  displayName?: string;
  status: SessionStatus;
  dataDir: string;
  daemonPort?: number;
  daemonPid?: number;
  lastConnected?: Date;
  lastDisconnected?: Date;
  lastQR?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SignalSessionSchema = new Schema<ISignalSession>(
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
      index: true,
    },
    phoneNumber: {
      type: String,
    },
    displayName: {
      type: String,
    },
    status: {
      type: String,
      enum: ['linking', 'connected', 'disconnected', 'unlinked', 'failed'],
      default: 'linking',
    },
    dataDir: {
      type: String,
      required: true,
    },
    daemonPort: {
      type: Number,
    },
    daemonPid: {
      type: Number,
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

export const SignalSession = mongoose.model<ISignalSession>(
  'SignalSession',
  SignalSessionSchema
);

// ──────────────────────────────────────────────
// Signal Chat
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Signal Message
// ──────────────────────────────────────────────

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
