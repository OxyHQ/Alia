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
import Expo, { type ExpoPushMessage, type ExpoPushReceiptId } from 'expo-server-sdk';
import { getDb } from '../db/index.js';
import {
  countUnread,
  createNotification,
  deactivatePushTokenById,
  deactivatePushTokenByToken,
  deactivateWebPushSubscriptionById,
  dismissNotification as dismissNotificationRow,
  hasActivePushToken,
  hasActiveWebPushSubscription,
  listActivePushTokens,
  listActiveWebPushSubscriptions,
  markAllNotificationsRead,
  markNotificationRead,
  setDeliveryStatus,
  touchPushTokens,
  type NotificationRow,
} from '../db/notifications/notificationRepository.js';
import type {
  NotificationChannel,
  NotificationPriority,
  NotificationTypeValue,
} from '../db/schema/notifications.js';
import { ConnectedAccount } from '../models/connected-account.js';
import { getStatusCode } from './errors/index.js';
import { Bot } from '../models/bot.js';
import { BotUser } from '../models/bot-user.js';
import { sendChannelMessage } from './channels/outbound.js';
import { webPush, VAPID_PUBLIC_KEY } from './web-push.js';
import { getIO } from '../socket.js';
import { log } from './logger.js';
import type { ChannelId } from './channels/types.js';

// ── Expo push singleton ──────────────────────────────────────────────
const expo = new Expo();

// ── Types ──────────────────────────────────────────────────────────

export interface SendNotificationOptions {
  userId: string;
  type: NotificationTypeValue;
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

  const userObjectId = new mongoose.Types.ObjectId(userId);

  // Check in parallel: push tokens, web push subscriptions, and Telegram account
  const [hasPushTokens, hasWebPushSubs, telegramBotUser] = await Promise.all([
    // Push: check if user has any active Expo push tokens
    hasActivePushToken(getDb(), userId).catch(() => false),

    // Web push: check if user has any active browser push subscriptions (only if VAPID configured)
    VAPID_PUBLIC_KEY ? hasActiveWebPushSubscription(getDb(), userId).catch(() => false) : false,

    // Telegram: check if user has a linked Telegram bot account
    (async () => {
      try {
        const bot = await Bot.findOne({ platform: 'telegram', status: 'active', userId: { $exists: false } });
        if (!bot) return null;
        return BotUser.findOne({
          botId: bot._id,
          oxyUserId: userObjectId,
          isLinked: true,
        });
      } catch {
        return null;
      }
    })(),
  ]);

  if (hasPushTokens || hasWebPushSubs) {
    channels.push('push');
  }

  if (telegramBotUser?.chatId) {
    channels.push('telegram');
  }

  return channels;
}

// ── Channel delivery implementations ───────────────────────────────

async function deliverInApp(notification: NotificationRow): Promise<boolean> {
  const io = getIO();
  if (!io) return false;

  io.to(`user:${notification.oxyUserId}`).emit('notification', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority,
    data: notification.data,
    createdAt: notification.createdAt,
  });

  return true;
}

async function deliverTelegram(userId: string, notification: NotificationRow): Promise<boolean> {
  const bot = await Bot.findOne({ platform: 'telegram', status: 'active', userId: { $exists: false } });
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
  notification: NotificationRow
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

// ── Expo Push Notifications ─────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered Expo push tokens.
 * Handles chunked sending (Expo limit) and async receipt checking.
 */
async function deliverPush(userId: string, notification: NotificationRow): Promise<boolean> {
  const tokens = await listActivePushTokens(getDb(), userId);

  if (tokens.length === 0) return false;

  // Build messages — one per device token
  const messages: ExpoPushMessage[] = [];
  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) {
      log.general.warn({ token: t.token, userId }, 'Invalid Expo push token, deactivating');
      await deactivatePushTokenById(getDb(), t.id);
      continue;
    }

    messages.push({
      to: t.token,
      title: notification.title,
      body: notification.body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        conversationId: notification.conversationId,
        ...notification.data,
      },
      sound: 'default',
      priority: notification.priority === 'urgent' || notification.priority === 'high' ? 'high' : 'normal',
      channelId: 'default',
    });
  }

  if (messages.length === 0) return false;

  // Send in chunks (Expo recommends batches of ~100)
  const chunks = expo.chunkPushNotifications(messages);
  const receiptIds: ExpoPushReceiptId[] = [];
  let anySucceeded = false;

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
          anySucceeded = true;
          if (ticket.id) {
            receiptIds.push(ticket.id);
          }
        } else {
          // ticket.status === 'error'
          const errorDetail = ticket as { status: 'error'; message: string; details?: { error: string } };
          const failedTo = chunk[i].to;
          const failedToken = Array.isArray(failedTo) ? failedTo[0] : failedTo;
          log.general.warn(
            { userId, token: failedToken, error: errorDetail.message, errorCode: errorDetail.details?.error },
            'Expo push ticket error',
          );

          // Deactivate tokens that are permanently invalid
          if (errorDetail.details?.error === 'DeviceNotRegistered') {
            // By TOKEN — an Expo receipt names no account.
            await deactivatePushTokenByToken(getDb(), failedToken);
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error, userId }, 'Expo push chunk send failed');
    }
  }

  // Fire-and-forget receipt checking (delayed)
  if (receiptIds.length > 0) {
    setTimeout(() => checkPushReceipts(receiptIds).catch(() => {}), 15_000);
  }

  // Update lastUsedAt for active tokens
  if (anySucceeded) {
    const activeTokenIds = tokens.filter(t => Expo.isExpoPushToken(t.token)).map(t => t.id);
    await touchPushTokens(getDb(), activeTokenIds);
  }

  return anySucceeded;
}

/**
 * Check push notification receipts after a delay.
 * Expo recommends checking ~15 seconds after sending.
 * Deactivates tokens that received DeviceNotRegistered errors.
 */
async function checkPushReceipts(receiptIds: ExpoPushReceiptId[]): Promise<void> {
  const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of chunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const { message, details } = receipt;
          log.general.warn({ receiptId, message, error: details?.error }, 'Expo push receipt error');

          // Deactivate invalid device tokens
          if (details?.error === 'DeviceNotRegistered') {
            // We can't directly map receiptId -> token, but Expo will stop delivering
            // to unregistered devices. The token gets deactivated on the next send attempt.
            log.general.info({ receiptId }, 'Device not registered — token will be deactivated on next send');
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error }, 'Failed to check Expo push receipts');
    }
  }
}

// ── Web Push Notifications ───────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered web push subscriptions.
 * Handles 410 Gone (expired subscription) by deactivating.
 */
async function deliverWebPush(userId: string, notification: NotificationRow): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) return false;

  const subscriptions = await listActiveWebPushSubscriptions(getDb(), userId);

  if (subscriptions.length === 0) return false;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    type: notification.type,
    conversationId: notification.conversationId,
    ...notification.data,
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          // The nested `keys` sub-document is two flat columns now.
          { endpoint: sub.endpoint, keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth } },
          payload,
        );
      } catch (error: unknown) {
        const statusCode = getStatusCode(error);
        if (statusCode === 410 || statusCode === 404) {
          // Subscription expired or invalid — deactivate
          await deactivateWebPushSubscriptionById(getDb(), sub.id);
          log.general.info({ userId, endpoint: sub.endpoint }, 'Web push subscription expired, deactivated');
        } else {
          log.general.warn({ err: error, userId, endpoint: sub.endpoint }, 'Web push delivery failed');
        }
        throw error; // Re-throw so Promise.allSettled marks as rejected
      }
    }),
  );

  return results.some(r => r.status === 'fulfilled');
}

function formatNotificationText(notification: NotificationRow): string {
  const priorityEmoji = notification.priority === 'urgent' ? '\u26a0\ufe0f '
    : notification.priority === 'high' ? '\u2757 '
    : '';

  return `${priorityEmoji}${notification.title}\n\n${notification.body}`;
}

// ── Main send function ─────────────────────────────────────────────

/**
 * Create and deliver a notification to a user across their preferred channels.
 */
export async function sendNotification(options: SendNotificationOptions): Promise<NotificationRow> {
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
  const notification = await createNotification(getDb(), {
    oxyUserId: userId,
    type,
    title,
    body: body.slice(0, 4000), // Cap body length
    data,
    channels,
    deliveryStatus: Object.fromEntries(channels.map(ch => [ch, 'pending'])),
    priority,
    triggerId,
    conversationId,
    expiresAt,
  });

  // `delivery_status` is a `jsonb` column written whole, so the per-channel
  // results accumulate here and are persisted in ONE update below. The source
  // mutated the sub-document in place and relied on `markModified` — forgetting
  // that call persisted nothing, silently.
  const deliveryStatus: Record<string, string> = { ...notification.deliveryStatus };

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
        case 'push': {
          // Deliver to both Expo (mobile) and web push in parallel
          const [expoPushOk, webPushOk] = await Promise.all([
            deliverPush(userId, notification),
            deliverWebPush(userId, notification),
          ]);
          success = expoPushOk || webPushOk;
          break;
        }
      }

      deliveryStatus[channel] = success ? 'sent' : 'failed';
    } catch (error: unknown) {
      log.general.error({ err: error, channel, userId }, 'Notification delivery failed');
      deliveryStatus[channel] = 'failed';
    }
  });

  await Promise.allSettled(deliveries);

  // Persist delivery status
  await setDeliveryStatus(getDb(), notification.id, deliveryStatus);

  log.general.info(
    { type, userId, channels, title: title.slice(0, 50) },
    'Notification sent',
  );

  return { ...notification, deliveryStatus };
}

// ── Query helpers ──────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  return countUnread(getDb(), userId);
}

export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  return markNotificationRead(getDb(), notificationId, userId);
}

export async function markAllAsRead(userId: string): Promise<number> {
  return markAllNotificationsRead(getDb(), userId);
}

export async function dismissNotification(notificationId: string, userId: string): Promise<boolean> {
  return dismissNotificationRow(getDb(), notificationId, userId);
}
