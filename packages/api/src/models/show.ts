import mongoose, { Schema, Model, Document } from 'mongoose';

export const SHOW_FORMATS = ['podcast', 'news', 'debate', 'interview', 'explainer'] as const;
export type ShowFormat = (typeof SHOW_FORMATS)[number];

export const ACTIVE_SHOW_STATUSES = ['queued', 'generating_script', 'generating_audio', 'concatenating'] as const;
export type ShowStatus = 'queued' | 'generating_script' | 'generating_audio' | 'concatenating' | 'completed' | 'failed';
export type ShowSegmentType = 'dialogue' | 'sfx' | 'transition';
export type ShowSpeakerRole = 'host' | 'co-host' | 'guest' | 'narrator';

export interface IShowSpeaker {
  name: string;
  voiceId: string;
  voiceName: string;
  role: ShowSpeakerRole;
}

export interface IShowSegment {
  index: number;
  speaker: string;
  text: string;
  audioUrl?: string;
  durationMs?: number;
  type: ShowSegmentType;
  sfxPrompt?: string;
}

export interface IShow extends Document {
  userId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  topic: string;
  format: ShowFormat;
  status: ShowStatus;
  speakers: IShowSpeaker[];
  segments: IShowSegment[];
  audioUrl?: string;
  durationMs?: number;
  error?: string;
  sourceConversationId?: string;
  sourceNotes?: string;
  creditsCharged?: number;
  progress: number;
  jobId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ShowSpeakerSchema = new Schema<IShowSpeaker>({
  name: { type: String, required: true },
  voiceId: { type: String, required: true },
  voiceName: { type: String, required: true },
  role: { type: String, enum: ['host', 'co-host', 'guest', 'narrator'], required: true },
}, { _id: false });

const ShowSegmentSchema = new Schema<IShowSegment>({
  index: { type: Number, required: true },
  speaker: { type: String, default: '' },
  text: { type: String, default: '' },
  audioUrl: String,
  durationMs: Number,
  type: { type: String, enum: ['dialogue', 'sfx', 'transition'], required: true },
  sfxPrompt: String,
}, { _id: false });

const ShowSchema = new Schema<IShow>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: String,
  topic: { type: String, required: true },
  format: {
    type: String,
    enum: ['podcast', 'news', 'debate', 'interview', 'explainer'],
    default: 'podcast',
  },
  status: {
    type: String,
    enum: ['queued', 'generating_script', 'generating_audio', 'concatenating', 'completed', 'failed'],
    default: 'queued',
  },
  speakers: [ShowSpeakerSchema],
  segments: [ShowSegmentSchema],
  audioUrl: String,
  durationMs: Number,
  error: String,
  sourceConversationId: String,
  sourceNotes: String,
  creditsCharged: Number,
  progress: { type: Number, default: 0 },
  jobId: String,
}, {
  timestamps: true,
});

ShowSchema.index({ userId: 1, createdAt: -1 });
ShowSchema.index({ userId: 1, status: 1 });

export const Show: Model<IShow> =
  mongoose.models.Show || mongoose.model<IShow>('Show', ShowSchema);
