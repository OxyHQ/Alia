import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IWebPushSubscription extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WebPushSubscriptionSchema = new Schema<IWebPushSubscription>(
  {
    oxyUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
    },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Each endpoint is unique per user
WebPushSubscriptionSchema.index({ oxyUserId: 1, endpoint: 1 }, { unique: true });

export const WebPushSubscription: Model<IWebPushSubscription> =
  mongoose.models.WebPushSubscription ||
  mongoose.model<IWebPushSubscription>('WebPushSubscription', WebPushSubscriptionSchema);
