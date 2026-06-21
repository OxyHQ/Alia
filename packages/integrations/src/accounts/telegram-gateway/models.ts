import mongoose, { Schema, Document } from 'mongoose';

// ──────────────────────────────────────────────
// Telegram Session
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Telegram Chat
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Telegram Message
// ──────────────────────────────────────────────

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
