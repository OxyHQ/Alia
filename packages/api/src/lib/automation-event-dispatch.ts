/**
 * Turning a stored Oxy application event into automation runs, and recovering
 * the ones whose processing was cut short.
 *
 * `POST /webhooks/oxy` stores the event, answers 202 and dispatches in the
 * background. The 202 is the point after which Oxy stops redelivering, so a
 * process that dies between the answer and the dispatch would lose the event
 * for good. {@link reapStalledAutomationEvents} closes that: it re-dispatches
 * any event still `received` or `matched` after {@link STALLED_AFTER_MS}.
 * Dispatching is idempotent (a run is keyed by the event id), so a sweep that
 * races a slow-but-alive dispatch produces one run, not two.
 */

import {
  claimStalledAutomationEvents,
  markAutomationEventStatus,
  matchingEventAutomations,
  type NormalizedAutomationEventInput,
} from '../db/automation/automationDefinitionRepository.js';
import { getDb } from '../db/index.js';
import { routeEventToAgentInboxes } from './agent/inbox-router.js';
import { dispatchStructuredAutomation } from './automation-dispatcher.js';
import { getErrorMessage } from './errors/index.js';
import { log } from './logger.js';
import { sendNotification } from './notification-service.js';

/** A healthy dispatch settles in seconds; this is well past the slowest one. */
export const STALLED_AFTER_MS = 2 * 60_000;
/** An event this old is no longer worth acting on. */
export const STALLED_MAX_AGE_MS = 24 * 60 * 60_000;
const SWEEP_BATCH = 50;

export async function dispatchEvent(event: NormalizedAutomationEventInput): Promise<void> {
  // Agents that subscribed to this event hear about it through their inbox, whether or not any
  // automation also matches (ADR 0026). Idempotent, so a re-dispatch adds nothing.
  await routeEventToAgentInboxes(event);
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

/** {@link dispatchEvent}, with a failure recorded and told to the person. */
export async function dispatchEventReportingFailure(
  event: NormalizedAutomationEventInput,
): Promise<void> {
  try {
    await dispatchEvent(event);
  } catch (error: unknown) {
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
  }
}

/**
 * Re-dispatch events a dead instance left unfinished. Safe on every task: each
 * event is claimed by a conditional UPDATE, so one instance gets each.
 * Returns how many it picked up.
 */
export async function reapStalledAutomationEvents(now: Date = new Date()): Promise<number> {
  const events = await claimStalledAutomationEvents(getDb(), {
    now,
    staleMs: STALLED_AFTER_MS,
    maxAgeMs: STALLED_MAX_AGE_MS,
    limit: SWEEP_BATCH,
  });
  for (const event of events) await dispatchEventReportingFailure(event);
  if (events.length > 0) {
    log.triggers.warn({ count: events.length }, 'Re-dispatched Oxy events left unfinished');
  }
  return events.length;
}
