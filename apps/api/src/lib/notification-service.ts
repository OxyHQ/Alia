/**
 * Notification Service
 *
 * Delivers notifications to users via multiple channels:
 * - in_app: Socket.io real-time event
 * - push: Expo push notifications (mobile)
 * - telegram/discord/whatsapp/slack: via channel outbound system
 *
 * Each notification is persisted and can be delivered to multiple channels simultaneously.
 */

import mongoose from 'mongoose';
import { Notification, type INotification, type NotificationType, type NotificationChannel, type NotificationPriority } from '../models/notification.js';
import { ConnectedAccount } from '../models/connected-account.js';
import { Bot } from '../models/bot.js';
import { BotUser } from '../models/bot-user.js';
import { sendChannelMessage } from './channels/outbound.js';
import { getIO } from '../socket.js';
import { log } from './logger.js';
import type { ChannelId } from './channels/types.js';

// ── Types ──────────────────────────────────────────────────────────

export interface SendNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
  data?: Record<string, any>;
  triggerId?: string;
  conversationId?: string;
  expiresAt?: Date;
}

// ── Resolve delivery channels ──────────────────────────────────────

/**
 * Determine which channels to deliver a notification to.
 * If explicit channels are provided, use those. Otherwise, default to in_app
 * plus any connected messaging accounts the user has.
 */
async function resolveChannels(userId: string, explicit?: NotificationChannel[]): Promise<NotificationChannel[]> {
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  // Default: always in_app
  const channels: NotificationChannel[] = ['in_app'];

  // Check if user has a linked Telegram account
  try {
    const bot = await Bot.findOne({ platform: 'telegram', status: 'active' });
    if (bot) {
      const botUser = await BotUser.findOne({
        botId: bot._id,
        oxyUserId: new mongoose.Types.ObjectId(userId),
        isLinked: true,
      });
      if (botUser?.chatId) {
        channels.push('telegram');
      }
    }
  } catch {
    // Ignore — Telegram not available
  }

  return channels;
}

// ── Channel delivery implementations ───────────────────────────────

async function deliverInApp(notification: INotification): Promise<boolean> {
  const io = getIO();
  if (!io) return false;

  io.to(`user:${notification.oxyUserId.toString()}`).emit('notification', {
    id: notification._id.toString(),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority,
    data: notification.data,
    createdAt: notification.createdAt,
  });

  return true;
}

async function deliverTelegram(userId: string, notification: INotification): Promise<boolean> {
  const bot = await Bot.findOne({ platform: 'telegram', status: 'active' });
  if (!bot) return false;

  const botUser = await BotUser.findOne({
    botId: bot._id,
    oxyUserId: new mongoose.Types.ObjectId(userId),
    isLinked: true,
  });
  if (!botUser?.chatId) return false;

  const text = formatNotificationText(notification);
  const results = await sendChannelMessage('telegram', botUser.chatId, text);
  return results.length > 0 && results[0].ok;
}

async function deliverViaChannel(
  channelId: ChannelId,
  userId: string,
  notification: INotification
): Promise<boolean> {
  // Find user's connected account for this channel
  const account = await ConnectedAccount.findOne({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    platform: channelId,
    status: 'connected',
  });

  if (!account?.accountId) return false;

  const text = formatNotificationText(notification);
  const results = await sendChannelMessage(channelId, account.accountId, text);
  return results.length > 0 && results[0].ok;
}

function formatNotificationText(notification: INotification): string {
  const priorityEmoji = notification.priority === 'urgent' ? '\u26a0\ufe0f '
    : notification.priority === 'high' ? '\u2757 '
    : '';

  return `${priorityEmoji}${notification.title}\n\n${notification.body}`;
}

// ── Main send function ─────────────────────────────────────────────

/**
 * Create and deliver a notification to a user across their preferred channels.
 */
export async function sendNotification(options: SendNotificationOptions): Promise<INotification> {
  const {
    userId,
    type,
    title,
    body,
    priority = 'normal',
    data,
    triggerId,
    conversationId,
    expiresAt,
  } = options;

  const channels = await resolveChannels(userId, options.channels);

  // Persist the notification
  const notification = await Notification.create({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    type,
    title,
    body: body.slice(0, 4000), // Cap body length
    data,
    channels,
    deliveryStatus: Object.fromEntries(channels.map(ch => [ch, 'pending'])),
    status: 'sent',
    priority,
    triggerId: triggerId ? new mongoose.Types.ObjectId(triggerId) : undefined,
    conversationId,
    expiresAt,
  });

  // Deliver to each channel in parallel
  const deliveries = channels.map(async (channel) => {
    try {
      let success = false;

      switch (channel) {
        case 'in_app':
          success = await deliverInApp(notification);
          break;
        case 'telegram':
          success = await deliverTelegram(userId, notification);
          break;
        case 'discord':
        case 'whatsapp':
        case 'slack':
          success = await deliverViaChannel(channel, userId, notification);
          break;
        case 'push':
          // TODO: Implement Expo push notifications (expo-server-sdk)
          success = false;
          break;
      }

      notification.deliveryStatus[channel] = success ? 'sent' : 'failed';
    } catch (error: any) {
      log.general.error({ err: error, channel, userId }, 'Notification delivery failed');
      notification.deliveryStatus[channel] = 'failed';
    }
  });

  await Promise.allSettled(deliveries);

  // Persist delivery status
  notification.markModified('deliveryStatus');
  await notification.save();

  log.general.info(
    { type, userId, channels, title: title.slice(0, 50) },
    'Notification sent',
  );

  return notification;
}

// ── Query helpers ──────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  return Notification.countDocuments({
    oxyUserId: new mongoose.Types.ObjectId(userId),
    status: { $in: ['pending', 'sent'] },
  });
}

export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  const result = await Notification.updateOne(
    { _id: notificationId, oxyUserId: new mongoose.Types.ObjectId(userId) },
    { $set: { status: 'read', readAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

export async function markAllAsRead(userId: string): Promise<number> {
  const result = await Notification.updateMany(
    {
      oxyUserId: new mongoose.Types.ObjectId(userId),
      status: { $in: ['pending', 'sent'] },
    },
    { $set: { status: 'read', readAt: new Date() } },
  );
  return result.modifiedCount;
}

export async function dismissNotification(notificationId: string, userId: string): Promise<boolean> {
  const result = await Notification.updateOne(
    { _id: notificationId, oxyUserId: new mongoose.Types.ObjectId(userId) },
    { $set: { status: 'dismissed' } },
  );
  return result.modifiedCount > 0;
}
