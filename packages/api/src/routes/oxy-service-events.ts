/**
 * Normalized Oxy application events.
 *
 * The caller is authenticated by Oxy's service identity. Alia stores neither a
 * per-app webhook secret nor a user bearer, and an event can only claim an app
 * whose signed capability catalog is owned by the calling application.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  claimAutomationEvent,
  createAutomationRunForSession,
  markAutomationEventStatus,
  matchingEventAutomations,
  type NormalizedAutomationEventInput,
} from '../db/automation/automationDefinitionRepository.js';
import { createAgentSession, updateAgentSession } from '../db/agents/agentSessionRepository.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import { getOxyAgentCapabilityMap } from '../lib/tools/oxy-services.js';
import { enqueueAgentSession } from '../lib/task-queue.js';
import { sendNotification } from '../lib/notification-service.js';
import { getErrorMessage } from '../lib/errors/index.js';
import { log } from '../lib/logger.js';

const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');

const resourceSchema = z.object({
  appId: z.string().min(1),
  effectiveAccountId: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
}).strict();

const normalizedEventSchema = z.object({
  eventId: z.string().min(1),
  appId: z.string().min(1),
  accountId: z.string().min(1),
  resource: resourceSchema,
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  data: z.record(z.unknown()).default({}),
}).strict();

const serviceIdentitySchema = z.object({
  service: z.object({
    appId: z.string().min(1),
    scopes: z.array(z.string()),
  }).passthrough(),
  catalogAppIds: z.array(z.string()),
  catalogs: z.array(z.object({
    appId: z.string().min(1),
    eventTypes: z.array(z.string().min(1)),
  }).strict()),
}).strict();

type EventResource = z.infer<typeof resourceSchema>;

function bearer(request: Request): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function identifyPublisher(token: string) {
  const response = await fetch(`${OXY_API_URL}/capabilities/service-identity`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Oxy service identity rejected (${response.status})`);
  return serviceIdentitySchema.parse(await response.json());
}

function assignmentCoversEvent(assignment: {
  resource: EventResource;
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  toolNames: readonly string[];
}, eventResource: EventResource): boolean {
  if (assignment.maximumAutonomy !== 'autonomous' || assignment.toolNames.length === 0) return false;
  const granted = assignment.resource;
  if (granted.appId !== eventResource.appId
    || granted.effectiveAccountId !== eventResource.effectiveAccountId) return false;
  if (granted.resourceType === eventResource.resourceType) {
    return granted.resourceId === eventResource.resourceId;
  }
  // An email-account grant intentionally contains its mailboxes. No other
  // resource hierarchy is inferred here; apps must delegate it explicitly.
  return granted.appId === 'inbox'
    && granted.resourceType === 'email_account'
    && eventResource.resourceType === 'mailbox'
    && granted.resourceId === granted.effectiveAccountId;
}

async function eligibleAgent(
  ownerAccountId: string,
  candidateIds: readonly string[],
  resource: EventResource,
) {
  for (const agentId of candidateIds) {
    const agent = await findAgentById(getDb(), agentId);
    if (!agent || agent.author !== ownerAccountId) continue;
    try {
      const assignments = await getOxyAgentCapabilityMap({
        requesterAccountId: ownerAccountId,
        ownerAccountId,
        actor: { type: 'agent', accountId: agent.oxyAccountId },
        autonomy: 'autonomous',
      });
      if (assignments.some((assignment) => assignmentCoversEvent(assignment, resource))) return agent;
    } catch (error: unknown) {
      log.triggers.warn({ err: error, agentId, ownerAccountId }, 'Agent capability-map lookup failed closed');
    }
  }
  return null;
}

async function notifyNoExecution(event: NormalizedAutomationEventInput, reason: string): Promise<void> {
  await sendNotification({
    userId: event.accountId,
    type: 'oxy_service',
    title: `${event.appId} automation did not run`,
    body: reason,
    priority: 'normal',
    channels: ['in_app', 'push'],
    data: { eventId: event.eventId, appId: event.appId, eventType: event.eventType },
  });
}

async function dispatchEvent(event: NormalizedAutomationEventInput): Promise<void> {
  const definitions = await matchingEventAutomations(getDb(), event);
  if (definitions.length === 0) {
    await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'processed');
    return;
  }
  await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'matched');

  for (const { row, eligibleAgentIds } of definitions) {
    if (row.maximumAutonomy !== 'autonomous') {
      await notifyNoExecution(event, `“${row.objective}” needs approval under its ${row.maximumAutonomy} policy.`);
      continue;
    }
    const candidates = row.actorMode === 'fixed' && row.fixedAgentId
      ? [row.fixedAgentId]
      : eligibleAgentIds;
    const agent = await eligibleAgent(event.accountId, candidates, event.resource);
    if (!agent) {
      await notifyNoExecution(event, `No eligible agent currently has access to ${event.resource.resourceType} ${event.resource.resourceId}.`);
      continue;
    }

    const task = [
      row.objective,
      '',
      'This run was triggered by a normalized Oxy event. Use only the delegated resource and minimum event data below.',
      JSON.stringify({
        eventId: event.eventId,
        appId: event.appId,
        type: event.eventType,
        occurredAt: event.occurredAt.toISOString(),
        resource: event.resource,
        data: event.data,
      }),
    ].join('\n');
    const session = await createAgentSession(getDb(), {
      agentId: agent.id,
      oxyUserId: event.accountId,
      task,
      status: 'queued',
      messages: [{ role: 'user', content: task, timestamp: new Date() }],
    });
    const claimed = await createAutomationRunForSession({
      db: getDb(),
      sessionId: session.id,
      automationId: row.id,
      requesterAccountId: event.accountId,
      selectedAgentId: agent.id,
      selectedActorAccountId: agent.oxyAccountId,
      triggerEventId: event.eventId,
      resource: event.resource,
      objective: row.objective,
    });
    if (!claimed) {
      await updateAgentSession(getDb(), session.id, {
        status: 'cancelled',
        result: 'Duplicate automation event',
      });
      continue;
    }
    await enqueueAgentSession({
      sessionId: session.id,
      userId: event.accountId,
      agentId: agent.id,
      agentName: `Agent ${agent.id}`,
    });
  }
  await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'processed');
}

const router = Router();

router.post('/', async (request: Request, response: Response) => {
  const token = bearer(request);
  if (!token) return response.status(401).json({ error: 'service_bearer_required' });
  const parsed = normalizedEventSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'invalid_normalized_event', details: parsed.error.flatten() });
  }
  if (parsed.data.resource.appId !== parsed.data.appId) {
    return response.status(400).json({ error: 'event_resource_app_mismatch' });
  }
  if (parsed.data.resource.effectiveAccountId !== parsed.data.accountId) {
    return response.status(400).json({ error: 'event_resource_account_mismatch' });
  }
  let publisher: z.infer<typeof serviceIdentitySchema>;
  try {
    publisher = await identifyPublisher(token);
  } catch (error: unknown) {
    log.triggers.warn({ err: error }, 'Oxy event publisher authentication failed');
    return response.status(401).json({ error: 'invalid_service_identity' });
  }
  if (!publisher.service.scopes.includes('capability-events:publish')) {
    return response.status(403).json({ error: 'insufficient_service_scope', requiredScope: 'capability-events:publish' });
  }
  if (!publisher.catalogAppIds.includes(parsed.data.appId)) {
    return response.status(403).json({ error: 'catalog_not_owned_by_service' });
  }
  const publisherCatalog = publisher.catalogs.find((catalog) => catalog.appId === parsed.data.appId);
  if (!publisherCatalog?.eventTypes.includes(parsed.data.type)) {
    return response.status(400).json({ error: 'event_type_not_in_catalog' });
  }
  const event: NormalizedAutomationEventInput = {
    eventId: parsed.data.eventId,
    appId: parsed.data.appId,
    accountId: parsed.data.accountId,
    resource: parsed.data.resource,
    eventType: parsed.data.type,
    occurredAt: new Date(parsed.data.occurredAt),
    data: parsed.data.data,
  };
  try {
    const claimed = await claimAutomationEvent(getDb(), event);
    if (!claimed) return response.status(202).json({ accepted: true, duplicate: true });
    void dispatchEvent(event).catch(async (error: unknown) => {
      log.triggers.error({ err: error, eventId: event.eventId, appId: event.appId }, 'Normalized Oxy event failed');
      await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'failed').catch(() => undefined);
      await notifyNoExecution(event, `Event processing failed: ${getErrorMessage(error).slice(0, 200)}`).catch(() => undefined);
    });
    return response.status(202).json({ accepted: true, duplicate: false });
  } catch (error: unknown) {
    log.triggers.error({ err: error, eventId: event.eventId }, 'Could not persist normalized Oxy event');
    return response.status(503).json({ error: 'event_store_unavailable' });
  }
});

/** Legacy per-service HMAC webhooks are deliberately not accepted. */
router.post('/:legacyServiceId', (_request: Request, response: Response) => response.status(410).json({
  error: 'legacy_oxy_webhook_retired',
  replacement: 'POST /webhooks/oxy with an Oxy service bearer and normalized event',
}));

export default router;
