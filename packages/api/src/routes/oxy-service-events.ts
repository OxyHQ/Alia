/**
 * Normalized Oxy application events.
 *
 * The caller is authenticated by Oxy's service identity. Alia stores neither a
 * per-app webhook secret nor a user bearer, and an event can only claim an app
 * whose signed capability catalog is owned by the calling application.
 */

import { Router, type Request, type Response } from 'express';
import { ALIA_SERVICE_AUDIENCE } from '@alia.onl/server/internal';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  claimAutomationEvent,
  markAutomationEventStatus,
  matchingEventAutomations,
  type NormalizedAutomationEventInput,
} from '../db/automation/automationDefinitionRepository.js';
import { dispatchStructuredAutomation } from '../lib/automation-dispatcher.js';
import { getErrorMessage } from '../lib/errors/index.js';
import { log } from '../lib/logger.js';
import { oxyServiceClient } from '../lib/oxy-service-client.js';
import { sendNotification } from '../lib/notification-service.js';
import { handleInboxEmailEvent } from '../lib/proactive/email-outreach.js';

const resourceSchema = z
  .object({
    appId: z.string().min(1),
    effectiveAccountId: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
  })
  .strict();

const normalizedEventSchema = z
  .object({
    eventId: z.string().min(1),
    appId: z.string().min(1),
    accountId: z.string().min(1),
    resource: resourceSchema,
    type: z.string().min(1),
    occurredAt: z.string().datetime(),
    data: z.record(z.unknown()).default({}),
  })
  .strict();

const publisherCatalogSchema = z.object({
  appSlug: z.string().min(1),
  registeredByApplicationId: z.string().min(1),
  active: z.literal(true),
  catalog: z.object({ events: z.array(z.object({ type: z.string().min(1) })) }),
});

async function dispatchEvent(event: NormalizedAutomationEventInput): Promise<void> {
  const definitions = await matchingEventAutomations(getDb(), event);
  if (definitions.length === 0) {
    await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'processed');
    return;
  }
  await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'matched');

  for (const automation of definitions) {
    await dispatchStructuredAutomation(automation, {
      kind: 'event',
      id: event.eventId,
      occurredAt: event.occurredAt,
      resource: event.resource,
      appId: event.appId,
      eventType: event.eventType,
      data: event.data,
    });
  }
  await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'processed');
}

/**
 * Fields an event may carry that Alia uses in passing and never stores.
 *
 * Inbox's `new_email` carries a one-line `snippet` of the body for the
 * importance classifier (`lib/proactive/email-outreach.ts`). Sender and subject
 * were already part of the stored projection; the body, even a line of it, is
 * not something `automation_events` needs to keep.
 */
const TRANSIENT_EVENT_FIELDS = ['snippet'] as const;

function storedEventData(data: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...data };
  for (const field of TRANSIENT_EVENT_FIELDS) delete stored[field];
  return stored;
}

/** Inbox's "an email arrived" — the one event Alia also reads for her own initiative. */
function isNewEmail(event: NormalizedAutomationEventInput): boolean {
  return event.appId === 'inbox' && event.eventType === 'new_email';
}

const router = Router();

router.post('/', async (request: Request, response: Response, next) => {
  if (!request.headers.authorization?.startsWith('Bearer '))
    return response.status(401).json({ error: 'service_bearer_required' });
  const parsed = normalizedEventSchema.safeParse(request.body);
  if (!parsed.success) {
    return response
      .status(400)
      .json({ error: 'invalid_normalized_event', details: parsed.error.flatten() });
  }
  if (parsed.data.resource.appId !== parsed.data.appId) {
    return response.status(400).json({ error: 'event_resource_app_mismatch' });
  }
  if (parsed.data.resource.effectiveAccountId !== parsed.data.accountId) {
    return response.status(400).json({ error: 'event_resource_account_mismatch' });
  }
  const oxy = oxyServiceClient();
  if (!oxy) return response.status(503).json({ error: 'service_verifier_unavailable' });
  // Core verifies the signature, recipient and live binding. Its finite central
  // bridge handles old cohort v1 issuers; a brand or scope string is not trust.
  await oxy.middleware.service({ expectedAudience: ALIA_SERVICE_AUDIENCE })(
    request,
    response,
    () => {
      void acceptVerifiedEvent(request, response, parsed.data).catch(next);
    },
  );
});

async function acceptVerifiedEvent(
  request: Request,
  response: Response,
  input: z.infer<typeof normalizedEventSchema>,
) {
  const publisher = request.serviceApp;
  if (!publisher) return response.status(401).json({ error: 'invalid_service_identity' });
  if (
    publisher.authority !== 'first_party' &&
    !publisher.scopes?.includes('capability-events:publish')
  ) {
    return response
      .status(403)
      .json({ error: 'insufficient_service_scope', requiredScope: 'capability-events:publish' });
  }
  let registrations;
  try {
    // Discover with Alia's own platform transport; never forward an Alia-audience
    // caller token to Oxy. Registry ownership is checked against the live caller.
    const oxy = oxyServiceClient();
    if (!oxy) throw new Error('Service verifier unavailable');
    registrations = await oxy.agency.serviceCatalogs({ appId: input.appId });
  } catch (error: unknown) {
    log.triggers.warn({ err: error }, 'Oxy event catalog unavailable');
    return response.status(503).json({ error: 'event_catalog_unavailable' });
  }
  const catalog = registrations
    .map((row) => publisherCatalogSchema.safeParse(row))
    .find(
      (row) =>
        row.success &&
        row.data.appSlug === input.appId &&
        row.data.registeredByApplicationId === publisher.appId,
    );
  if (!catalog?.success)
    return response.status(403).json({ error: 'catalog_not_owned_by_service' });
  if (!catalog.data.catalog.events.some((event) => event.type === input.type)) {
    return response.status(400).json({ error: 'event_type_not_in_catalog' });
  }
  const event: NormalizedAutomationEventInput = {
    eventId: input.eventId,
    appId: input.appId,
    accountId: input.accountId,
    resource: input.resource,
    eventType: input.type,
    occurredAt: new Date(input.occurredAt),
    data: storedEventData(input.data),
  };
  try {
    const claimed = await claimAutomationEvent(getDb(), event);
    if (!claimed) return response.status(202).json({ accepted: true, duplicate: true });
    // Independent of any automation, and of their failure notification: an
    // important email is told by Alia or by the agent whose mailbox it is.
    if (isNewEmail(event)) {
      void handleInboxEmailEvent({
        accountId: event.accountId,
        occurredAt: event.occurredAt,
        data: input.data,
      }).catch((error: unknown) => {
        log.triggers.warn({ err: error, eventId: event.eventId }, 'Email outreach did not run');
      });
    }
    void dispatchEvent(event).catch(async (error: unknown) => {
      log.triggers.error(
        { err: error, eventId: event.eventId, appId: event.appId },
        'Normalized Oxy event failed',
      );
      await markAutomationEventStatus(getDb(), event.appId, event.eventId, 'failed').catch(
        () => undefined,
      );
      await sendNotification({
        userId: event.accountId,
        type: 'oxy_service',
        title: `${event.appId} automation failed`,
        body: `Event processing failed: ${getErrorMessage(error).slice(0, 200)}`,
        priority: 'normal',
        channels: ['in_app', 'push'],
        data: { eventId: event.eventId, appId: event.appId, eventType: event.eventType },
      }).catch(() => undefined);
    });
    return response.status(202).json({ accepted: true, duplicate: false });
  } catch (error: unknown) {
    log.triggers.error(
      { err: error, eventId: event.eventId },
      'Could not persist normalized Oxy event',
    );
    return response.status(503).json({ error: 'event_store_unavailable' });
  }
}

/** Legacy per-service HMAC webhooks are deliberately not accepted. */
router.post('/:legacyServiceId', (_request: Request, response: Response) =>
  response.status(410).json({
    error: 'legacy_oxy_webhook_retired',
    replacement: 'POST /webhooks/oxy with an Oxy service bearer and normalized event',
  }),
);

export default router;
