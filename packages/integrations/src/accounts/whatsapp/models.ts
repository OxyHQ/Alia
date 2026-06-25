import mongoose, { Schema, Document } from 'mongoose';

// ──────────────────────────────────────────────
// WhatsApp Session
// ──────────────────────────────────────────────

export type SessionStatus = 'qr-pending' | 'connected' | 'disconnected' | 'logged-out' | 'failed';

export interface IWhatsAppSession extends Document {
  sessionId: string;
  oxyUserId: string;
  phoneNumber?: string;
  displayName?: string;
  status: SessionStatus;
  authState: unknown; // Serialized Baileys auth creds
  authKeys: Map<string, unknown>; // Serialized Baileys auth keys (pre-keys, sessions, sender-keys, etc.)
  lastConnected?: Date;
  lastDisconnected?: Date;
  lastQR?: string;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppSessionSchema = new Schema<IWhatsAppSession>(
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
      enum: ['qr-pending', 'connected', 'disconnected', 'logged-out', 'failed'],
      default: 'qr-pending',
    },
    authState: {
      type: Schema.Types.Mixed,
      default: null,
    },
    authKeys: {
      type: Map,
      of: Schema.Types.Mixed,
      default: new Map(),
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

export const WhatsAppSession = mongoose.model<IWhatsAppSession>(
  'WhatsAppSession',
  WhatsAppSessionSchema
);

// ──────────────────────────────────────────────
// WhatsApp Chat
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// WhatsApp Message
// ──────────────────────────────────────────────

export interface IWhatsAppMessage extends Document {
  sessionId: string;
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
    sessionId: { type: String, required: true, index: true },
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

WhatsAppMessageSchema.index({ sessionId: 1, jid: 1, timestamp: -1 });
WhatsAppMessageSchema.index({ sessionId: 1, messageId: 1 }, { unique: true });

export const WhatsAppMessage = mongoose.model<IWhatsAppMessage>('WhatsAppMessage', WhatsAppMessageSchema);
