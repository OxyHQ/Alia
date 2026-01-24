import mongoose from 'mongoose';

export interface IActivityPubFollower {
  actorUri: string;
  handle: string;
  inbox: string;
  sharedInbox?: string;
  followedAt: Date;
  status: 'accepted' | 'pending' | 'rejected';
}

const ActivityPubFollowerSchema = new mongoose.Schema<IActivityPubFollower>({
  actorUri: { type: String, required: true, unique: true, index: true },
  handle: { type: String, required: true },
  inbox: { type: String, required: true },
  sharedInbox: { type: String },
  followedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['accepted', 'pending', 'rejected'], default: 'accepted' },
});

export const ActivityPubFollower = mongoose.model<IActivityPubFollower>('ActivityPubFollower', ActivityPubFollowerSchema);
