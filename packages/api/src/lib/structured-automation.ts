import { getDb } from '../db/index.js';
import {
  upsertLegacyTriggerAutomation,
} from '../db/automation/automationDefinitionRepository.js';
import type { TriggerRecord } from '../db/automation/triggerRepository.js';
import { scheduleToCron } from './trigger-engine.js';

/**
 * Keep the transitional scheduler and the normalized automation control plane
 * aligned from every creation path, including conversational tool calls.
 */
export async function syncStructuredAutomation(trigger: TriggerRecord) {
  const schedule = trigger.schedule;
  const isSchedule = trigger.type === 'schedule' || trigger.type === 'agent_heartbeat';
  return upsertLegacyTriggerAutomation({
    db: getDb(),
    legacyTriggerId: trigger._id,
    ownerAccountId: trigger.oxyUserId,
    objective: trigger.action.prompt,
    triggerKind: isSchedule ? 'schedule' : 'event',
    ...(!isSchedule ? {
      eventAppId: trigger.integrationEvent?.service ?? 'external_webhook',
      eventType: trigger.integrationEvent?.event ?? 'webhook',
    } : {}),
    ...(schedule ? {
      scheduleCron: scheduleToCron(schedule) ?? undefined,
      scheduleTimezone: schedule.timezone ?? 'UTC',
    } : {}),
    fixedAgentId: trigger.action.agentId,
    inputs: {
      useTools: trigger.action.useTools,
      notify: trigger.action.notify ?? false,
      ...(trigger.action.channelId ? { channelId: trigger.action.channelId } : {}),
    },
    enabled: trigger.enabled,
  });
}

type StructuredAutomation = Awaited<ReturnType<typeof syncStructuredAutomation>>;

/** User-editable receipt returned by both HTTP and conversational creation. */
export function automationReceipt(automation: StructuredAutomation) {
  return {
    trigger: automation.trigger,
    actors: automation.actorSelection,
    resources: automation.resources,
    dataFlow: automation.dataFlow,
    maximumAutonomy: automation.maximumAutonomy,
    limits: automation.limits,
    undo: { method: 'DELETE' as const, path: `/automations/${automation.id}` },
  };
}
