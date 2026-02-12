/**
 * FallbackEvent Model
 *
 * Records fallback attempts for analytics and debugging.
 * Each document represents one request that went through the fallback engine.
 * Auto-deleted after 30 days via TTL index.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IFallbackAttemptRecord {
  provider: string;
  model: string;
  error: string;
  reason: string;
  latencyMs: number;
}

export interface IFallbackEvent extends Document {
  timestamp: Date;
  aliasModel: string;
  attempts: IFallbackAttemptRecord[];
  finalProvider: string | null;
  finalModel: string | null;
  success: boolean;
  totalLatencyMs: number;
}

const FallbackEventSchema = new Schema<IFallbackEvent>({
  timestamp: { type: Date, default: Date.now, index: true },
  aliasModel: { type: String, required: true },
  attempts: [{
    provider: String,
    model: String,
    error: String,
    reason: String,
    latencyMs: Number,
  }],
  finalProvider: { type: String },
  finalModel: { type: String },
  success: { type: Boolean, required: true },
  totalLatencyMs: { type: Number },
});

// TTL: auto-delete after 30 days
FallbackEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Index for analytics queries
FallbackEventSchema.index({ aliasModel: 1, timestamp: -1 });
FallbackEventSchema.index({ success: 1, timestamp: -1 });

export const FallbackEvent = mongoose.models.FallbackEvent || mongoose.model<IFallbackEvent>('FallbackEvent', FallbackEventSchema);
