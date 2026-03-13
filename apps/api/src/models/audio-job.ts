import mongoose, { Schema, Document, Model } from 'mongoose';
import { log } from '../lib/logger.js';

export type AudioJobStatus = 'processing' | 'completed' | 'failed';

export interface IAudioJob {
  userId: string;
  status: AudioJobStatus;
  audioUrl?: string;
  error?: string;
  prompt: string;
  duration: number;
  conversationId?: string;
  messageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAudioJobDocument extends IAudioJob, Document {}

interface IAudioJobModel extends Model<IAudioJobDocument> {
  cleanupOrphanedJobs(): Promise<number>;
}

const AudioJobSchema = new Schema<IAudioJobDocument>(
  {
    userId: { type: String, required: true, index: true },
    status: { type: String, required: true, enum: ['processing', 'completed', 'failed'], default: 'processing' },
    audioUrl: String,
    error: String,
    prompt: { type: String, required: true },
    duration: { type: Number, required: true },
    conversationId: String,
    messageId: String,
  },
  { timestamps: true }
);

// Auto-delete jobs after 24 hours — they're ephemeral
AudioJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

/**
 * Mark orphaned 'processing' jobs as failed.
 * Jobs stuck in 'processing' for >5 minutes are likely from a crashed process
 * (normal generation completes within 3 minutes).
 */
AudioJobSchema.statics.cleanupOrphanedJobs = async function (): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const result = await this.updateMany(
    { status: 'processing', createdAt: { $lt: cutoff } },
    { $set: { status: 'failed', error: 'Job orphaned — server restarted during generation' } }
  );
  const count = result.modifiedCount;
  if (count > 0) {
    log.general.info({ count }, 'Cleaned up orphaned audio jobs');
  }
  return count;
};

export const AudioJob = mongoose.model<IAudioJobDocument, IAudioJobModel>('AudioJob', AudioJobSchema);
