import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  countTriggerExecutions,
  createTrigger,
  deleteTriggerForUser,
  findTriggerForUser,
  listTriggerExecutions,
  listTriggers,
  updateTrigger,
} from '../db/automation/triggerRepository.js';
import type { TriggerTypeValue } from '../db/schema/automation.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  executeTrigger,
  reloadTrigger,
  processWebhookTrigger,
  generateWebhookToken,
} from '../lib/trigger-engine.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// ── Authenticated CRUD routes ──────────────────────────────────────

const authRouter = Router();
authRouter.use(authenticateToken);

// GET /triggers — list user's triggers
authRouter.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const { type } = req.query;
    const narrowed = ['schedule', 'webhook', 'integration_event'].includes(type as string)
      ? (type as TriggerTypeValue)
      : undefined;

    const triggers = await listTriggers(getDb(), req.user.id, { type: narrowed });
    res.json({ triggers });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error listing triggers');
    res.status(500).json({ error: 'Failed to list triggers' });
  }
});

// GET /triggers/:id — get single trigger
authRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const trigger = await findTriggerForUser(getDb(), String(req.params.id), req.user.id);
    if (!trigger) return res.status(404).json({ error: 'Trigger not found' });

    res.json({ trigger });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error getting trigger');
    res.status(500).json({ error: 'Failed to get trigger' });
  }
});

// POST /triggers — create trigger
authRouter.post('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const { name, description, type, action, schedule, webhook, integrationEvent, enabled } = req.body;

    // Validate required fields
    if (!name || !type || !action?.prompt) {
      return res.status(400).json({ error: 'name, type, and action.prompt are required' });
    }

    if (!['schedule', 'webhook', 'integration_event'].includes(type)) {
      return res.status(400).json({ error: 'type must be "schedule", "webhook", or "integration_event"' });
    }

    // Validate schedule config
    if (type === 'schedule') {
      if (!schedule || !schedule.type) {
        return res.status(400).json({ error: 'schedule.type is required for schedule triggers' });
      }
      if (!['cron', 'daily', 'interval'].includes(schedule.type)) {
        return res.status(400).json({ error: 'schedule.type must be "cron", "daily", or "interval"' });
      }
      if (schedule.type === 'cron' && !schedule.cron) {
        return res.status(400).json({ error: 'schedule.cron is required for cron type' });
      }
      if (schedule.type === 'interval' && (!schedule.intervalMinutes || schedule.intervalMinutes < 1)) {
        return res.status(400).json({ error: 'schedule.intervalMinutes must be >= 1 for interval type' });
      }
      if (schedule.type === 'daily' && schedule.time && !/^\d{2}:\d{2}$/.test(schedule.time)) {
        return res.status(400).json({ error: 'schedule.time must be in HH:MM format' });
      }
    }

    // Validate integration event config
    if (type === 'integration_event') {
      if (!integrationEvent?.service || !integrationEvent?.event) {
        return res.status(400).json({ error: 'integrationEvent.service and integrationEvent.event are required' });
      }
    }

    // Auto-generate webhook token for webhook triggers
    const webhookConfig = type === 'webhook' ? {
      token: generateWebhookToken(),
      ...webhook,
    } : webhook;

    const trigger = await createTrigger(getDb(), {
      oxyUserId: req.user.id,
      name,
      description,
      type,
      action: {
        prompt: action.prompt,
        agentId: action.agentId,
        roleId: action.roleId,
        useTools: action.useTools ?? false,
        notify: action.notify ?? false,
        channelId: action.channelId,
      },
      schedule: type === 'schedule' ? schedule : undefined,
      webhook: type === 'webhook' ? webhookConfig : undefined,
      integrationEvent: type === 'integration_event' ? integrationEvent : undefined,
      enabled: enabled ?? true,
    });

    // Reload scheduler if it's a schedule trigger
    reloadTrigger(trigger._id).catch((err) =>
      log.triggers.error({ err }, 'Failed to reload trigger')
    );

    // Build webhook URL for response
    const triggerResponse: Record<string, unknown> = { ...trigger };
    if (type === 'webhook' && trigger.webhook?.token) {
      const baseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
      triggerResponse.webhookUrl = `${baseUrl}/triggers/webhook/${trigger.webhook.token}`;
    }

    res.status(201).json({ trigger: triggerResponse });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error creating trigger');
    res.status(500).json({ error: 'Failed to create trigger' });
  }
});

// PATCH /triggers/:id — update trigger
authRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const existing = await findTriggerForUser(getDb(), String(req.params.id), req.user.id);
    if (!existing) return res.status(404).json({ error: 'Trigger not found' });

    const { name, description, action, schedule, webhook, integrationEvent, enabled } = req.body;

    // `action` and `webhook` MERGE into what is stored; `schedule` and
    // `integrationEvent` REPLACE it. That asymmetry is the source's — the first
    // two went through `trigger.set('x', {...trigger.x, ...patch})` and the
    // other two were assigned — and the repository reproduces it column by
    // column, so a replacement clears the keys it does not name.
    const trigger = await updateTrigger(getDb(), existing._id, {
      name,
      description,
      enabled,
      action,
      schedule,
      integrationEvent,
      webhook,
    });

    reloadTrigger(existing._id).catch((err) =>
      log.triggers.error({ err }, 'Failed to reload trigger')
    );

    res.json({ trigger });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error updating trigger');
    res.status(500).json({ error: 'Failed to update trigger' });
  }
});

// DELETE /triggers/:id — delete trigger
authRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const deleted = await deleteTriggerForUser(getDb(), String(req.params.id), req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Trigger not found' });

    reloadTrigger(String(req.params.id)).catch((err) =>
      log.triggers.error({ err }, 'Failed to reload trigger')
    );

    res.json({ success: true });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error deleting trigger');
    res.status(500).json({ error: 'Failed to delete trigger' });
  }
});

// POST /triggers/:id/run — manual trigger execution
authRouter.post('/:id/run', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const trigger = await findTriggerForUser(getDb(), String(req.params.id), req.user.id);
    if (!trigger) return res.status(404).json({ error: 'Trigger not found' });

    const { success, result, executionId } = await executeTrigger(trigger, {
      source: 'manual',
      payload: req.body.payload,
    });

    res.json({ success, result, executionId, trigger });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error running trigger');
    res.status(500).json({ error: 'Failed to run trigger' });
  }
});

// GET /triggers/:id/executions — get trigger execution history
authRouter.get('/:id/executions', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    // Verify trigger ownership
    const trigger = await findTriggerForUser(getDb(), String(req.params.id), req.user.id);
    if (!trigger) return res.status(404).json({ error: 'Trigger not found' });

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const executions = await listTriggerExecutions(getDb(), trigger._id, { limit, offset });
    const total = await countTriggerExecutions(getDb(), trigger._id);

    res.json({ executions, total, limit, offset });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error listing executions');
    res.status(500).json({ error: 'Failed to list executions' });
  }
});

// POST /triggers/:id/regenerate-token — regenerate webhook token
authRouter.post('/:id/regenerate-token', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const existing = await findTriggerForUser(getDb(), String(req.params.id), req.user.id);
    if (!existing) return res.status(404).json({ error: 'Trigger not found' });
    if (existing.type !== 'webhook') return res.status(400).json({ error: 'Only webhook triggers have tokens' });

    const newToken = generateWebhookToken();
    // A MERGE, so an existing HMAC secret and IP allowlist survive the rotation.
    const trigger = await updateTrigger(getDb(), existing._id, { webhook: { token: newToken } });

    const baseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
    res.json({
      trigger,
      webhookUrl: `${baseUrl}/triggers/webhook/${newToken}`,
    });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error regenerating token');
    res.status(500).json({ error: 'Failed to regenerate token' });
  }
});

// ── Webhook ingestion (public, no auth — token-based) ──────────────

// POST /triggers/webhook/:token — receive webhook payload
router.post('/webhook/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const payload = req.body || {};

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }

    const { success, result, triggerId, executionId } = await processWebhookTrigger(
      String(token),
      payload,
      headers
    );

    if (!success && !triggerId) {
      return res.status(404).json({ error: result || 'Trigger not found' });
    }

    if (!success) {
      return res.status(403).json({ error: result || 'Webhook rejected' });
    }

    res.json({ success, result, triggerId, executionId });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error processing webhook');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Mount authenticated routes
router.use('/', authRouter);

export default router;
