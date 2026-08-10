import mongoose, { Schema, Model, Document } from 'mongoose';
import { FILE_CATEGORIES, FileCategory } from '../value-sets/library-file.js';

export interface ILibraryFile extends Document {
  name: string;
  url: string;
  type: string;
  size: number;
  category: FileCategory;
  owner: mongoose.Types.ObjectId;
  thumbnail?: string;
  createdAt: Date;
  updatedAt: Date;
}

const LibraryFileSchema = new Schema<ILibraryFile>({
  name: { type: String, required: true },
  url: { type: String, required: true },
  type: { type: String, required: true },
  size: { type: Number, required: true },
  category: {
    type: String,
    enum: [...FILE_CATEGORIES],
    required: true,
  },
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  thumbnail: { type: String },
}, {
  timestamps: true,
});

LibraryFileSchema.index({ owner: 1, createdAt: -1 });

export const LibraryFile: Model<ILibraryFile> = mongoose.models.LibraryFile || mongoose.model<ILibraryFile>('LibraryFile', LibraryFileSchema);
