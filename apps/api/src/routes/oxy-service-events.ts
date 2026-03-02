/**
 * Oxy Service Events — Webhook endpoint for Oxy apps to push events to Alia
 *
 * When an Oxy service (e.g., Inbox) has an event (new email, calendar reminder),
 * it POSTs here. Alia processes the event based on the configured action:
 *   - "notify" → send notification to the user
 *   - "context" → update cached user context (silent)
 *   - "autonomous" → enqueue an agent session to handle it
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { OxyService } from '../models/oxy-service.js';
import { sendNotification } from '../lib/notification-service.js';
import { log } from '../lib/logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// HMAC signature verification
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// POST /webhooks/oxy/:serviceId — Receive events from Oxy services
// ---------------------------------------------------------------------------

router.post('/:serviceId', async (req: Request, res: Response) => {
  const { serviceId } = req.params;

  try {
    // 1. Look up the service
    const service = await OxyService.findOne({ serviceId, status: 'active' }).lean();
    if (!service) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }

    // 2. Verify HMAC signature if webhookSecret is configured
    if (service.webhookSecret) {
      const signature = req.headers['x-oxy-signature'] as string;
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }

      const rawBody = JSON.stringify(req.body);
      if (!verifySignature(rawBody, signature, service.webhookSecret)) {
        log.general.warn({ serviceId }, 'Invalid webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    // 3. Parse event
    const { userId, event, data, title, message } = req.body;

    if (!userId || !event) {
      res.status(400).json({ error: 'Missing required fields: userId, event' });
      return;
    }

    // 4. Respond immediately — process async
    res.sendStatus(200);

    // 5. Find the event definition in the service manifest
    const eventDef = service.events?.find((e) => e.name === event);
    const action = eventDef?.action || 'notify';

    // 6. Process based on action type
    processEvent(serviceId as string, service.displayName, action, userId, event, data, title, message).catch(
      (err) => log.general.error({ err, serviceId, event }, 'Failed to process Oxy service event'),
    );
  } catch (err) {
    log.general.error({ err, serviceId }, 'Oxy service webhook error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

async function processEvent(
  serviceId: string,
  displayName: string,
  action: string,
  userId: string,
  event: string,
  data?: any,
  title?: string,
  message?: string,
): Promise<void> {
  log.general.info({ serviceId, event, action, userId }, 'Processing Oxy service event');

  switch (action) {
    case 'notify': {
      await sendNotification({
        userId,
        type: 'oxy_service',
        title: title || `${displayName}: ${event}`,
        body: message || `New event from ${displayName}`,
        data: { serviceId, event, ...data },
      });
      break;
    }

    case 'context': {
      // Context updates are stored in the service's own data store.
      // Alia reads fresh context via contextEndpoint at chat start.
      // This event is a no-op signal for now — future: invalidate context cache.
      log.general.info({ serviceId, event, userId }, 'Context event received (no-op for now)');
      break;
    }

    case 'autonomous': {
      // Enqueue an agent session to handle the event autonomously.
      // Future: integrate with task-queue.ts enqueueAgentSession()
      try {
        const { enqueueAgentSession } = await import('../lib/task-queue.js');
        await enqueueAgentSession({
          sessionId: `oxy-event-${serviceId}-${Date.now()}`,
          userId,
          agentId: 'system',
          agentName: `${displayName} Event Handler`,
        });
      } catch (err) {
        log.general.warn({ err, serviceId, event }, 'Failed to enqueue autonomous event handler');
        // Fall back to notification
        await sendNotification({
          userId,
          type: 'oxy_service',
          title: title || `${displayName}: ${event}`,
          body: message || `New event from ${displayName}`,
          data: { serviceId, event, ...data },
        });
      }
      break;
    }

    default:
      log.general.warn({ serviceId, event, action }, 'Unknown event action');
  }
}

export default router;
