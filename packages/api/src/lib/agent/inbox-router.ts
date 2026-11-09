/**
 * Putting an Oxy event in the inboxes of the agents that asked to hear about it (ADR 0026).
 *
 * Called for every stored event (`automation-event-dispatch.ts`), before automations. It is idempotent:
 * an item's `dedupe_key` is `<appId>:<eventId>`, so a redelivery or the stalled-event sweep re-routing
 * the same event adds nothing.
 */

import { addInboxItem, matchingAgentSubscriptions } from '../../db/agents/agentInboxRepository.js';
import type { NormalizedAutomationEventInput } from '../../db/automation/automationDefinitionRepository.js';
import { getDb } from '../../db/index.js';

/** What an inbox keeps of an event: where and when, plus the projection `automation_events` stores. */
function summaryOf(event: NormalizedAutomationEventInput): Record<string, unknown> {
  return {
    occurredAt: event.occurredAt.toISOString(),
    resourceType: event.resource.resourceType,
    resourceId: event.resource.resourceId,
    ...event.data,
  };
}

/** Returns how many inboxes received the event. */
export async function routeEventToAgentInboxes(
  event: NormalizedAutomationEventInput,
): Promise<number> {
  const db = getDb();
  const subscriptions = await matchingAgentSubscriptions(db, event);
  let added = 0;
  const seen = new Set<string>();
  for (const subscription of subscriptions) {
    // One agent with a wildcard and an exact subscription is told once.
    if (seen.has(subscription.agentId)) continue;
    seen.add(subscription.agentId);
    const stored = await addInboxItem(db, {
      agentId: subscription.agentId,
      ownerAccountId: subscription.ownerAccountId,
      appId: event.appId,
      eventType: event.eventType,
      dedupeKey: `${event.appId}:${event.eventId}`,
      summary: summaryOf(event),
    });
    if (stored) added += 1;
  }
  return added;
}
