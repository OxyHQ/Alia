import { Router } from 'express';
import { Notification } from '../models/notification.js';
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    log.general.error({ err: error }, 'Error dismissing notification');
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});

export default router;
