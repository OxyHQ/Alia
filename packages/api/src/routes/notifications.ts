import { Router } from 'express';
import Expo from 'expo-server-sdk';
import { getDb } from '../db/index.js';
import {
  deactivatePushToken,
  deactivateWebPushSubscription,
  listNotifications,
  upsertPushToken,
  upsertWebPushSubscription,
} from '../db/notifications/notificationRepository.js';
import {
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  PUSH_TOKEN_PLATFORMS,
  type NotificationStatus,
  type NotificationTypeValue,
} from '../db/schema/notifications.js';
import { authenticateToken } from '../middleware/auth.js';
import { getUnreadCount, markAsRead, markAllAsRead, dismissNotification } from '../lib/notification-service.js';
import { VAPID_PUBLIC_KEY } from '../lib/web-push.js';
import { log } from '../lib/logger.js';
import {
  EMAIL_ALERTS_DEFAULT,
  listEmailAlertPreferences,
  setEmailAlertPreference,
} from '../db/proactive/emailOutreachRepository.js';
import { findAgentById, listAgentsOwnedBy } from '../db/agents/agentRepository.js';
import { attachAgentIdentities } from '../lib/agent-identity.js';
import type { Request, Response } from 'express';

const router = Router();

// ── Public route (no auth) — VAPID public key for browser subscription ──
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  // Unconfigured web push is a normal state, not a server error — a 503 here
  // spams every browser console. Clients treat a null key as "unavailable".
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

router.use(authenticateToken);

// GET /notifications — list user's notifications (paginated)
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;

    const { status, type, limit = '30', offset = '0' } = req.query;

    /**
     * The filters are CHECKED against the closed value sets rather than passed
     * through. Under Mongo an unknown `status` simply matched nothing; here it
     * would be compared against a `text` column with a CHECK, which is still a
     * legal comparison — so the behaviour is the same, but stating the narrowing
     * is what lets the repository take a typed filter instead of `any`.
     */
    const statusFilter: NotificationStatus | undefined =
      typeof status === 'string' && (NOTIFICATION_STATUSES as readonly string[]).includes(status)
        ? (status as NotificationStatus)
        : undefined;
    const typeFilter: NotificationTypeValue | undefined =
      typeof type === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(type)
        ? (type as NotificationTypeValue)
        : undefined;

    const [page, unreadCount] = await Promise.all([
      listNotifications(getDb(), {
        oxyUserId: userId,
        status: statusFilter,
        type: typeFilter,
        limit: Math.min(Number(limit), 100),
        offset: Number(offset),
      }),
      getUnreadCount(userId),
    ]);

    res.json({ notifications: page.notifications, total: page.total, unreadCount });
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
    const { id } = req.params;
    if (typeof id !== 'string') return res.status(404).json({ error: 'Notification not found' });
    const success = await markAsRead(id, userId);
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
    const { id } = req.params;
    if (typeof id !== 'string') return res.status(404).json({ error: 'Notification not found' });
    const success = await dismissNotification(id, userId);
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

    if (platform && !(PUSH_TOKEN_PLATFORMS as readonly string[]).includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform (must be ios, android, or web)' });
    }

    // Upsert: if user already registered this token, just reactivate it
    const pushToken = await upsertPushToken(getDb(), userId, token, deviceId, platform);

    log.general.info({ userId, tokenId: pushToken.id }, 'Push token registered');
    res.json({ success: true, id: pushToken.id });
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

    // `matchedCount === 0` becomes `rowCount === 0` — a direct port, because
    // `matchedCount` is exactly what `rowCount` reports.
    const deactivated = await deactivatePushToken(getDb(), userId, token);
    if (!deactivated) {
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

    const subscription = await upsertWebPushSubscription(
      getDb(),
      userId,
      endpoint,
      keys.p256dh,
      keys.auth,
    );

    log.general.info({ userId, subscriptionId: subscription.id }, 'Web push subscription registered');
    res.json({ success: true, id: subscription.id });
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

    const deactivated = await deactivateWebPushSubscription(getDb(), userId, endpoint);
    if (!deactivated) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    log.general.info({ userId }, 'Web push subscription deactivated');
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deactivating web push subscription');
    res.status(500).json({ error: 'Failed to deactivate web push subscription' });
  }
});

/**
 * GET /notifications/email-alerts — "Avísame de emails importantes", per actor.
 *
 * `alia` is about the person's own Inbox. `agents` lists every agent whose
 * bot account the person owns — the ones that would write to them about mail
 * in their OWN mailbox (`lib/proactive/email-outreach.ts`). Unset is on.
 */
router.get('/email-alerts', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const [preferences, owned] = await Promise.all([
      listEmailAlertPreferences(getDb(), userId),
      listAgentsOwnedBy(getDb(), userId),
    ]);
    const agents = await attachAgentIdentities(owned);
    res.json({
      alia: { enabled: preferences.get(null) ?? EMAIL_ALERTS_DEFAULT },
      agents: agents.map((agent) => ({
        agentId: agent._id,
        name: agent.name,
        handle: agent.handle,
        color: agent.color,
        enabled: preferences.get(agent._id) ?? EMAIL_ALERTS_DEFAULT,
      })),
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error reading email alert settings');
    res.status(500).json({ error: 'Failed to read email alert settings' });
  }
});

/**
 * PUT /notifications/email-alerts `{ agentId: string | null, enabled: boolean }`.
 *
 * `agentId` null is Alia. An agent's switch is its owner's alone: the same
 * `owner_oxy_account_id` that decides whom the agent tells decides who may
 * silence it, and anybody else gets the 404 an unknown agent does.
 */
router.put('/email-alerts', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.user.id as string;
    const { agentId, enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean' || (agentId !== null && typeof agentId !== 'string')) {
      return res.status(400).json({ error: 'agentId (string or null) and enabled (boolean) are required' });
    }
    if (agentId !== null) {
      const agent = await findAgentById(getDb(), agentId);
      if (!agent || agent.ownerOxyAccountId !== userId) return res.status(404).json({ error: 'Agent not found' });
    }
    await setEmailAlertPreference(getDb(), { oxyUserId: userId, agentId, enabled });
    res.json({ agentId, enabled });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error saving email alert setting');
    res.status(500).json({ error: 'Failed to save email alert setting' });
  }
});

export default router;
