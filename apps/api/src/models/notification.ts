import mongoose, { Schema, Model, Document } from 'mongoose';

export type NotificationType =
  | 'trigger_result'
  | 'proactive_insight'
  | 'daily_briefing'
  | 'price_alert'
  | 'integration_event'
  | 'reminder';

export type NotificationChannel = 'push' | 'telegram' | 'discord' | 'whatsapp' | 'slack' | 'in_app';
export type NotificationStatus = 'pending' | 'sent' | 'read' | 'dismissed';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface INotification extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
  channels: NotificationChannel[];
  deliveryStatus: Record<string, 'pending' | 'sent' | 'failed'>;
  status: NotificationStatus;
  priority: NotificationPriority;
  triggerId?: mongoose.Types.ObjectId;
  conversationId?: string;
  expiresAt?: Date;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>({
  oxyUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    required: true,
    enum: ['trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder'],
  },
  title: { type: String, required: true },
  body: { type: String, required: true },
  data: { type: Schema.Types.Mixed },
  channels: [{
    type: String,
    enum: ['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app'],
  }],
  deliveryStatus: { type: Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['pending', 'sent', 'read', 'dismissed'],
    default: 'pending',
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal',
  },
  triggerId: { type: Schema.Types.ObjectId, ref: 'Trigger' },
  conversationId: { type: String },
  expiresAt: { type: Date },
  readAt: { type: Date },
}, {
  timestamps: true,
});

// Query by user + status for notification feed
NotificationSchema.index({ oxyUserId: 1, status: 1, createdAt: -1 });
// Unread count query
NotificationSchema.index({ oxyUserId: 1, status: { $in: ['pending', 'sent'] } as any });
// TTL: auto-delete dismissed/expired notifications after 90 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { status: 'dismissed' } });

export const Notification: Model<INotification> = mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
