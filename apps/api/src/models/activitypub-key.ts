import mongoose from 'mongoose';

export interface IActivityPubKey {
  actor: string;
  publicKey: string;
  privateKey: string;
  createdAt: Date;
}

const ActivityPubKeySchema = new mongoose.Schema<IActivityPubKey>({
  actor: { type: String, required: true, unique: true, index: true },
  publicKey: { type: String, required: true },
  privateKey: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const ActivityPubKey = mongoose.model<IActivityPubKey>('ActivityPubKey', ActivityPubKeySchema);
