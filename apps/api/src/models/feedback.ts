import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IFeedback extends Document {
  userId: mongoose.Types.ObjectId;
  type: 'bug' | 'feature' | 'improvement' | 'other';
  rating?: number;
  message: string;
  email?: string;
  metadata?: {
    platform?: string;
    appVersion?: string;
    deviceInfo?: string;
    [key: string]: any;
  };
  status: 'pending' | 'reviewed' | 'resolved';
  createdAt: Date;
  updatedAt: Date;
}

const FeedbackSchema = new Schema<IFeedback>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['bug', 'feature', 'improvement', 'other'],
    required: true
  },
  rating: {
    type: Number,
    min: 1,
    max: 5
  },
  message: { type: String, required: true },
  email: { type: String },
  metadata: {
    platform: { type: String },
    appVersion: { type: String },
    deviceInfo: { type: String }
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'resolved'],
    default: 'pending'
  }
}, {
  timestamps: true
});

FeedbackSchema.index({ userId: 1, createdAt: -1 });
FeedbackSchema.index({ status: 1 });
FeedbackSchema.index({ type: 1 });

export const Feedback: Model<IFeedback> =
  mongoose.models.Feedback || mongoose.model<IFeedback>('Feedback', FeedbackSchema);
