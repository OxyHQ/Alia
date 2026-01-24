import mongoose from 'mongoose';

export interface IMention {
  handle: string;
  uri: string;
}

export interface IActivityPubPost {
  postId: string;
  content: string;
  inReplyTo?: string;
  published: Date;
  to: string[];
  cc: string[];
  mentions: IMention[];
}

const ActivityPubPostSchema = new mongoose.Schema<IActivityPubPost>({
  postId: { type: String, required: true, unique: true, index: true },
  content: { type: String, required: true },
  inReplyTo: { type: String },
  published: { type: Date, default: Date.now },
  to: [{ type: String }],
  cc: [{ type: String }],
  mentions: [{
    handle: { type: String },
    uri: { type: String }
  }],
});

export const ActivityPubPost = mongoose.model<IActivityPubPost>('ActivityPubPost', ActivityPubPostSchema);
