import mongoose, { Schema, Document } from 'mongoose';

export interface IDeveloperApp extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  websiteUrl?: string;
  redirectUrls: string[];
  icon?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DeveloperAppSchema = new Schema<IDeveloperApp>(
  {
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    websiteUrl: {
      type: String,
      trim: true,
    },
    redirectUrls: {
      type: [String],
      default: [],
    },
    icon: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for user-specific queries
DeveloperAppSchema.index({ oxyUserId: 1, isActive: 1 });

const DeveloperApp = mongoose.model<IDeveloperApp>('DeveloperApp', DeveloperAppSchema);

export default DeveloperApp;
