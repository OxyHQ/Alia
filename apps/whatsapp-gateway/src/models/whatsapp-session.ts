import mongoose, { Schema, Document } from 'mongoose';

export type SessionStatus = 'qr-pending' | 'connected' | 'disconnected' | 'logged-out';

export interface IWhatsAppSession extends Document {
  oxyUserId: string;
  phoneNumber?: string;
  displayName?: string;
  status: SessionStatus;
  authState: any; // Serialized Baileys auth creds
  authKeys: Map<string, any>; // Serialized Baileys auth keys (pre-keys, sessions, sender-keys, etc.)
  lastConnected?: Date;
  lastDisconnected?: Date;
  lastQR?: string;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppSessionSchema = new Schema<IWhatsAppSession>(
  {
    oxyUserId: {
      type: String,
      required: true,
      unique: true,
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
      enum: ['qr-pending', 'connected', 'disconnected', 'logged-out'],
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
