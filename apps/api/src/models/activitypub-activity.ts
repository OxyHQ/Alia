import mongoose from 'mongoose';

export interface IActivityPubActivity {
  activityId: string;
  type: 'Create' | 'Follow' | 'Like' | 'Announce' | 'Accept' | 'Reject' | 'Undo' | 'Delete';
  actor: string;
  object: any;
  processed: boolean;
  processedAt?: Date;
  error?: string;
  createdAt: Date;
}

const ActivityPubActivitySchema = new mongoose.Schema<IActivityPubActivity>({
  activityId: { type: String, required: true, unique: true, index: true },
  type: { type: String, required: true, enum: ['Create', 'Follow', 'Like', 'Announce', 'Accept', 'Reject', 'Undo', 'Delete'] },
  actor: { type: String, required: true },
  object: { type: mongoose.Schema.Types.Mixed, required: true },
  processed: { type: Boolean, default: false },
  processedAt: { type: Date },
  error: { type: String },
  createdAt: { type: Date, default: Date.now, index: true },
});

export const ActivityPubActivity = mongoose.model<IActivityPubActivity>('ActivityPubActivity', ActivityPubActivitySchema);
