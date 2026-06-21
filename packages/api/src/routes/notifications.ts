import { Router } from 'express';
import mongoose from 'mongoose';
import Expo from 'expo-server-sdk';
import { Notification } from '../models/notification.js';
import { PushToken } from '../models/push-token.js';
import { WebPushSubscription } from '../models/web-push-subscription.js';
import { authenticateToken } from '../middleware/auth.js';
import { getUnreadCount, markAsRead, markAllAsRead, dismissNotification } from '../lib/notification-service.js';
import { VAPID_PUBLIC_KEY } from '../lib/web-push.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// ── Public route (no auth) — VAPID public key for browser subscription ──
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Web push not configured' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

router.use(authenticateToken);

// GET /notifications — list user's notifications (paginated)
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;

    const { status, type, limit = '30', offset = '0' } = req.query;
    const filter: Record<string, any> = { oxyUserId: userId };

    if (status && typeof status === 'string') {
      filter.status = status;
    }
    if (type && typeof type === 'string') {
      filter.type = type;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(Number(offset))
        .limit(Math.min(Number(limit), 100))
        .lean(),
      Notification.countDocuments(filter),
      getUnreadCount(userId),
    ]);

    res.json({ notifications, total, unreadCount });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error listing notifications');
    res.status(500).json({ error: 'Failed to list notifications' });
  }
});

// GET /notifications/unread-count
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const count = await getUnreadCount(req.user.id as string);
    res.json({ count });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error getting unread count');
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// PATCH /notifications/:id/read — mark single notification as read
router.patch('/:id/read', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const success = await markAsRead(req.params.id as string, userId);
    if (!success) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error marking notification as read');
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// POST /notifications/read-all — mark all notifications as read
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const count = await markAllAsRead(userId);
    res.json({ success: true, count });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error marking all as read');
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// PATCH /notifications/:id/dismiss — dismiss a notification
router.patch('/:id/dismiss', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const success = await dismissNotification(req.params.id as string, userId);
    if (!success) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error dismissing notification');
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});

// ── Push Token Management ─────────────────────────────────────────

// POST /notifications/push-token — register or update an Expo push token
router.post('/push-token', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { token, deviceId, platform } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Push token is required' });
    }

    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({ error: 'Invalid Expo push token format' });
    }

    if (platform && !['ios', 'android', 'web'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform (must be ios, android, or web)' });
    }

    // Upsert: if user already registered this token, just reactivate it
    const pushToken = await PushToken.findOneAndUpdate(
      {
        oxyUserId: new mongoose.Types.ObjectId(userId),
        token,
      },
      {
        $set: {
          active: true,
          ...(deviceId && { deviceId }),
          ...(platform && { platform }),
        },
        $setOnInsert: {
          oxyUserId: new mongoose.Types.ObjectId(userId),
          token,
        },
      },
      { upsert: true, new: true },
    );

    log.general.info({ userId, tokenId: pushToken._id }, 'Push token registered');
    res.json({ success: true, id: pushToken._id });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error registering push token');
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// DELETE /notifications/push-token — deactivate a push token (logout / uninstall)
router.delete('/push-token', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Push token is required' });
    }

    const result = await PushToken.updateOne(
      {
        oxyUserId: new mongoose.Types.ObjectId(userId),
        token,
      },
      { $set: { active: false } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Push token not found' });
    }

    log.general.info({ userId }, 'Push token deactivated');
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deactivating push token');
    res.status(500).json({ error: 'Failed to deactivate push token' });
  }
});

// ── Web Push Subscription Management ─────────────────────────────

// POST /notifications/web-push-subscription — save browser push subscription
router.post('/web-push-subscription', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { endpoint, keys } = req.body;

    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Subscription endpoint is required' });
    }
    if (!keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Subscription keys (p256dh, auth) are required' });
    }

    const subscription = await WebPushSubscription.findOneAndUpdate(
      {
        oxyUserId: new mongoose.Types.ObjectId(userId),
        endpoint,
      },
      {
        $set: {
          active: true,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
        },
        $setOnInsert: {
          oxyUserId: new mongoose.Types.ObjectId(userId),
          endpoint,
        },
      },
      { upsert: true, new: true },
    );

    log.general.info({ userId, subscriptionId: subscription._id }, 'Web push subscription registered');
    res.json({ success: true, id: subscription._id });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error registering web push subscription');
    res.status(500).json({ error: 'Failed to register web push subscription' });
  }
});

// DELETE /notifications/web-push-subscription — deactivate browser push subscription
router.delete('/web-push-subscription', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { endpoint } = req.body;

    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Subscription endpoint is required' });
    }

    const result = await WebPushSubscription.updateOne(
      {
        oxyUserId: new mongoose.Types.ObjectId(userId),
        endpoint,
      },
      { $set: { active: false } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    log.general.info({ userId }, 'Web push subscription deactivated');
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deactivating web push subscription');
    res.status(500).json({ error: 'Failed to deactivate web push subscription' });
  }
});

export default router;
