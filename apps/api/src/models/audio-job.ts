import mongoose, { Schema, Document } from 'mongoose';

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

export const AudioJob = mongoose.model<IAudioJobDocument>('AudioJob', AudioJobSchema);
