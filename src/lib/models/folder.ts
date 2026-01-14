import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IFolder extends Document {
  name: string;
  userId: string;
  color?: string;
  icon?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FolderSchema = new Schema<IFolder>({
  name: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  color: { type: String, default: 'gray' },
  icon: { type: String },
}, {
  timestamps: true
});

// Create compound index for unique folder names per user
FolderSchema.index({ userId: 1, name: 1 }, { unique: true });

export const Folder: Model<IFolder> = mongoose.models.Folder || mongoose.model<IFolder>('Folder', FolderSchema);
