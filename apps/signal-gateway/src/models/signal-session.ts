import mongoose, { Schema, Document } from 'mongoose';

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
