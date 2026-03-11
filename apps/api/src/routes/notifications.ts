import { Router } from 'express';
import mongoose from 'mongoose';
import Expo from 'expo-server-sdk';
import { Notification } from '../models/notification.js';
import { PushToken } from '../models/push-token.js';
import { authenticateToken } from '../middleware/auth.js';
import { getUnreadCount, markAsRead, markAllAsRead, dismissNotification } from '../lib/notification-service.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();
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

export default router;
