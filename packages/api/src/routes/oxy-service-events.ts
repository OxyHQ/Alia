/**
 * Oxy Service Events — Webhook endpoint for Oxy apps to push events to Alia.
 *
 * - Idempotent by eventId (dedupe at DB level)
 * - Autonomous mode always creates a persisted AgentSession before enqueue
 * - Guaranteed fallback to notification on autonomous execution failure
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { OxyService } from '../models/oxy-service.js';
import { OxyServiceEventLog } from '../models/oxy-service-event-log.js';
import { Agent } from '../models/agent.js';
import { AgentSession } from '../models/agent-session.js';
import { ContextSource } from '../models/context-source.js';
import { ContextNode } from '../models/context-node.js';
import { sendNotification } from '../lib/notification-service.js';
import { enqueueAgentSession } from '../lib/task-queue.js';
import { log } from '../lib/logger.js';
import { getErrorMessage, isDuplicateKeyError } from '../lib/errors/index.js';
import { autonomyFlags } from '../lib/autonomy/flags.js';

const router = Router();

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function isObjectId(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value);
}

function hashPayload(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? {})).digest('hex');
}

function buildEventId(req: Request): string {
  const bodyEventId = typeof req.body?.eventId === 'string' ? req.body.eventId.trim() : '';
  const headerEventId = typeof req.headers['x-oxy-event-id'] === 'string' ? req.headers['x-oxy-event-id'].trim() : '';
  if (bodyEventId) return bodyEventId;
  if (headerEventId) return headerEventId;
  return `hash:${hashPayload(req.body)}`;
}

async function ensureAutonomyAgent(userId: string): Promise<mongoose.Types.ObjectId> {
  const handle = `alia-autonomy-${userId.slice(-8).toLowerCase()}`;

  const existing = await Agent.findOne({ author: userId, handle }).select('_id').lean();
  if (existing?._id) return existing._id;

  const created = await Agent.create({
    name: 'Alia Autonomy Runtime',
    handle,
    avatar: null,
    tagline: 'Autonomous event processor',
    description: 'System agent that processes service events autonomously with policy controls.',
    author: userId,
    authorName: 'Alia',
    authorVerified: true,
    category: 'automation',
    tags: ['autonomy', 'events', 'system'],
    capabilities: ['event processing', 'context retrieval', 'notification fallback'],
    isPublished: true,
    status: 'active',
    allowHiring: false,
    price: null,
    allowedModels: ['alia-v1', 'alia-v1-thinking'],
    systemPrompt: 'You process service events autonomously. Be concise, safe, and policy-compliant.',
  });

  return created._id;
}

async function notifyFallback(params: {
  userId: string;
  displayName: string;
  event: string;
  title?: string;
  message?: string;
  data?: any;
  reason?: string;
}) {
  await sendNotification({
    userId: params.userId,
    type: 'oxy_service',
    title: params.title || `${params.displayName}: ${params.event}`,
    body: params.message || `Event received from ${params.displayName}${params.reason ? ` (${params.reason})` : ''}`,
    data: { event: params.event, ...params.data, fallback: true, reason: params.reason },
    priority: 'high',
  });
}

async function ingestOxySignal(userId: string, serviceId: string, event: string, data?: any): Promise<void> {
  const now = new Date();
  await ContextSource.updateOne(
    { oxyUserId: userId, sourceKey: `oxy:${serviceId}` },
    {
      $setOnInsert: {
        oxyUserId: userId,
        sourceKey: `oxy:${serviceId}`,
        kind: 'oxy_service',
        label: serviceId,
      },
      $set: {
        freshnessScore: 0.95,
        precisionScore: 0.8,
        lastSuccessAt: now,
      },
      $inc: { successfulReads: 1 },
    },
    { upsert: true }
  ).catch(() => {});

  await ContextNode.updateOne(
    { oxyUserId: userId, nodeKey: `oxy-event:${serviceId}:${event}:${hashPayload(data).slice(0, 12)}` },
    {
      $setOnInsert: {
        oxyUserId: userId,
        nodeKey: `oxy-event:${serviceId}:${event}:${hashPayload(data).slice(0, 12)}`,
        type: 'service',
        label: `${serviceId}:${event}`,
      },
      $set: { lastSeenAt: now, freshnessScore: 0.95 },
    },
    { upsert: true }
  ).catch(() => {});
}

async function processEvent(params: {
  logId: mongoose.Types.ObjectId;
  serviceId: string;
  displayName: string;
  action: 'notify' | 'context' | 'autonomous';
  userId: string;
  event: string;
  data?: any;
  title?: string;
  message?: string;
}): Promise<void> {
  const { logId, serviceId, displayName, action, userId, event, data, title, message } = params;

  try {
    log.general.info({ serviceId, event, action, userId }, 'Processing Oxy service event');
    await ingestOxySignal(userId, serviceId, event, data);

    if (action === 'notify') {
      await sendNotification({
        userId,
        type: 'oxy_service',
        title: title || `${displayName}: ${event}`,
        body: message || `New event from ${displayName}`,
        data: { serviceId, event, ...data },
      });

      await OxyServiceEventLog.findByIdAndUpdate(logId, {
        $set: { status: 'processed', processedAt: new Date() },
      });
      return;
    }

    if (action === 'context') {
      // Context endpoint is pulled at chat-time; this event acts as freshness signal.
      await OxyServiceEventLog.findByIdAndUpdate(logId, {
        $set: { status: 'processed', processedAt: new Date() },
      });
      return;
    }

    if (!autonomyFlags.oxyAutonomousEnabled) {
      await notifyFallback({ userId, displayName, event, title, message, data, reason: 'autonomy_disabled' });
      await OxyServiceEventLog.findByIdAndUpdate(logId, {
        $set: { status: 'failed', processedAt: new Date(), errorMessage: 'autonomy_disabled' },
      });
      return;
    }

    if (!isObjectId(userId)) {
      await notifyFallback({ userId, displayName, event, title, message, data, reason: 'invalid_user_id' });
      await OxyServiceEventLog.findByIdAndUpdate(logId, {
        $set: { status: 'failed', processedAt: new Date(), errorMessage: 'invalid_user_id' },
      });
      return;
    }

    const agentId = await ensureAutonomyAgent(userId);
    const task = [
      `Process Oxy service event from ${displayName}.`,
      `Event: ${event}`,
      message ? `Message: ${message}` : '',
      data ? `Payload:\n${JSON.stringify(data, null, 2).slice(0, 6000)}` : '',
      'Return a concise summary and next actions.',
    ].filter(Boolean).join('\n\n');

    const session = await AgentSession.create({
      agentId,
      userId,
      status: 'queued',
      task,
      depth: 0,
      messages: [{ role: 'system', content: 'Autonomous Oxy service event execution', timestamp: new Date() }],
    });

    try {
      await enqueueAgentSession({
        sessionId: session._id.toString(),
        userId,
        agentId: agentId.toString(),
        agentName: 'Alia Autonomy Runtime',
      });

      await OxyServiceEventLog.findByIdAndUpdate(logId, {
        $set: {
          status: 'processed',
          processedAt: new Date(),
          agentSessionId: session._id,
        },
      });
    } catch (queueErr: unknown) {
      await notifyFallback({ userId, displayName, event, title, message, data, reason: 'autonomous_queue_failed' });

      await AgentSession.findByIdAndUpdate(session._id, {
        $set: {
          status: 'failed',
          result: 'Failed to enqueue autonomous session; fallback notification sent.',
          'stats.completedAt': new Date(),
          'stats.lastActivityAt': new Date(),
        },
      });

      await OxyServiceEventLog.findByIdAndUpdate(logId, {
        $set: {
          status: 'failed',
          processedAt: new Date(),
          errorMessage: getErrorMessage(queueErr) || 'autonomous_queue_failed',
          agentSessionId: session._id,
        },
      });
    }

    return;
  } catch (err: unknown) {
    await notifyFallback({ userId, displayName, event, title, message, data, reason: 'autonomous_execution_failed' }).catch(() => {});

    await OxyServiceEventLog.findByIdAndUpdate(logId, {
      $set: {
        status: 'failed',
        processedAt: new Date(),
        errorMessage: getErrorMessage(err) || 'unknown_error',
      },
    }).catch(() => {});

    log.general.error({ err, serviceId, event }, 'Failed to process Oxy service event');
  }
}

router.post('/:serviceId', async (req: Request, res: Response) => {
  const serviceId = req.params.serviceId as string;

  try {
    const service = await OxyService.findOne({ serviceId, status: 'active' }).lean();
    if (!service) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }

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

    const { userId, event, data, title, message } = req.body;
    if (!userId || !event) {
      res.status(400).json({ error: 'Missing required fields: userId, event' });
      return;
    }
    if (!isObjectId(userId)) {
      res.status(400).json({ error: 'Invalid userId' });
      return;
    }

    const action = (service.events?.find((e) => e.name === event)?.action || 'notify') as 'notify' | 'context' | 'autonomous';
    const eventId = buildEventId(req);
    const payloadHash = hashPayload(req.body);

    try {
      const eventLog = await OxyServiceEventLog.create({
        serviceId,
        oxyUserId: userId,
        eventId,
        eventName: event,
        action,
        status: 'received',
        payloadHash,
      });

      res.status(202).json({ accepted: true, eventId });

      processEvent({
        logId: eventLog._id,
        serviceId,
        displayName: service.displayName,
        action,
        userId,
        event,
        data,
        title,
        message,
      }).catch((err) => log.general.error({ err, serviceId, event }, 'Async processing failed'));
    } catch (insertErr: unknown) {
      if (isDuplicateKeyError(insertErr)) {
        await OxyServiceEventLog.updateOne(
          { serviceId, oxyUserId: userId, eventId },
          { $set: { status: 'duplicate', processedAt: new Date() } }
        ).catch(() => {});

        res.status(202).json({ accepted: true, duplicate: true, eventId });
        return;
      }

      throw insertErr;
    }
  } catch (err: unknown) {
    log.general.error({ err, serviceId }, 'Oxy service webhook error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

export default router;
