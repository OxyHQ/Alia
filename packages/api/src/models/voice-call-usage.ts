/**
 * Voice Call Usage Model
 *
 * Tracks real-time voice call sessions for billing and analytics
 */

import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IVoiceCallUsage extends Document {
  // Session identification
  sessionId: string;
  oxyUserId: string;
  aliaModelId: string;
  provider: string;
  providerModel: string;

  // Timing
  startTime: Date;
  endTime?: Date;
  durationMinutes: number;

  // Billing
  creditsCharged: number;
  costPerMinute: number;

  // Quality metrics
  averageLatencyMs?: number;
  disconnectReason?: string;

  // Metadata
  audioFormat: string;
  sampleRate: number;
  clientType?: string;

  // Cohost
  cohostEnabled: boolean;
  cohostProvider?: string;
  cohostProviderModel?: string;
  cohostDurationMinutes: number;
  cohostCreditsCharged: number;

  // Timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

const VoiceCallUsageSchema = new Schema<IVoiceCallUsage>(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
      unique: true,
    },
    oxyUserId: {
      type: String,
      required: true,
      index: true,
    },
    aliaModelId: {
      type: String,
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
      index: true,
    },
    providerModel: {
      type: String,
      required: true,
    },

    // Timing
    startTime: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    endTime: {
      type: Date,
    },
    durationMinutes: {
      type: Number,
      default: 0,
    },

    // Billing
    creditsCharged: {
      type: Number,
      default: 0,
    },
    costPerMinute: {
      type: Number,
      required: true,
    },

    // Quality metrics
    averageLatencyMs: {
      type: Number,
    },
    disconnectReason: {
      type: String,
    },

    // Metadata
    audioFormat: {
      type: String,
      required: true,
      default: 'pcm16',
    },
    sampleRate: {
      type: Number,
      required: true,
      default: 24000,
    },
    clientType: {
      type: String,
    },

    // Cohost fields
    cohostEnabled: {
      type: Boolean,
      default: false,
    },
    cohostProvider: {
      type: String,
    },
    cohostProviderModel: {
      type: String,
    },
    cohostDurationMinutes: {
      type: Number,
      default: 0,
    },
    cohostCreditsCharged: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for common queries
VoiceCallUsageSchema.index({ oxyUserId: 1, startTime: -1 });
VoiceCallUsageSchema.index({ provider: 1, startTime: -1 });
VoiceCallUsageSchema.index({ aliaModelId: 1, startTime: -1 });

export const VoiceCallUsage: Model<IVoiceCallUsage> =
  mongoose.models.VoiceCallUsage ||
  mongoose.model<IVoiceCallUsage>('VoiceCallUsage', VoiceCallUsageSchema);
