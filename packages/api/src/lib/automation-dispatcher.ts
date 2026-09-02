/** Shared policy, actor selection and queueing for normalized automations. */

import type { AutomationDefinitionRecord } from '../db/automation/automationDefinitionRepository.js';
import {
  automationHasActiveAuthorizationCoverage,
  createAutomationRunForSession,
  createObservedAutomationRun,
  markAutomationRunForSession,
} from '../db/automation/automationDefinitionRepository.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import { createAgentSession, updateAgentSession } from '../db/agents/agentSessionRepository.js';
import { getDb } from '../db/index.js';
import type { AutomationResourceRef } from '../db/schema/agency.js';
import { log } from './logger.js';
import { sendNotification } from './notification-service.js';
import { enqueueAgentSession } from './task-queue.js';
import { getOxyAgentCapabilityMap } from './tools/oxy-services.js';

type AutomationAction = AutomationDefinitionRecord['actions'][number];

export type AutomationDispatchTrigger =
  | {
      kind: 'event';
      id: string;
      occurredAt: Date;
      resource: AutomationResourceRef;
      appId: string;
      eventType: string;
      data: Record<string, unknown>;
    }
  | {
      kind: 'schedule';
      id: string;
      occurredAt: Date;
    };

export type AutomationDispatchResult =
  | { status: 'queued'; sessionId: string }
  | { status: 'observed' }
  | { status: 'duplicate' }
  | { status: 'denied'; reason: string };

function sameResource(left: AutomationResourceRef, right: AutomationResourceRef): boolean {
  return left.appId === right.appId
    && left.effectiveAccountId === right.effectiveAccountId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId;
}

function uniqueResources(resources: readonly AutomationResourceRef[]): AutomationResourceRef[] {
  return resources.filter((resource, index) => (
    resources.findIndex((candidate) => sameResource(candidate, resource)) === index
  ));
}

function assignmentCoversResource(assignment: {
  resource: AutomationResourceRef;
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
}, resource: AutomationResourceRef): boolean {
  if (assignment.maximumAutonomy !== 'autonomous') return false;
  const granted = assignment.resource;
  if (granted.appId !== resource.appId
    || granted.effectiveAccountId !== resource.effectiveAccountId) return false;
  if (granted.resourceType === resource.resourceType) return granted.resourceId === resource.resourceId;
  // An Inbox email-account grant contains its mailboxes. No hierarchy is
  // inferred for another app or resource type.
  return granted.appId === 'inbox'
    && granted.resourceType === 'email_account'
    && resource.resourceType === 'mailbox'
    && granted.resourceId === granted.effectiveAccountId;
}

export function assignmentsCoverAutomation(input: {
  assignments: ReadonlyArray<{
    resource: AutomationResourceRef;
    maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
    toolNames: readonly string[];
  }>;
  sourceResources: readonly AutomationResourceRef[];
  actions: readonly AutomationAction[];
}): boolean {
  const sourcesCovered = input.sourceResources.every((resource) => input.assignments.some((assignment) => (
    assignment.toolNames.length > 0 && assignmentCoversResource(assignment, resource)
  )));
  return sourcesCovered && input.actions.every((action) => input.assignments.some((assignment) => (
    assignment.toolNames.includes(action.tool)
    && assignmentCoversResource(assignment, action.resource)
  )));
}

async function eligibleAgent(
  automation: AutomationDefinitionRecord,
  sourceResources: readonly AutomationResourceRef[],
) {
  const candidateIds = automation.actorSelection.mode === 'fixed'
    ? [automation.actorSelection.agentId].filter((id): id is string => Boolean(id))
    : automation.actorSelection.eligibleAgentIds;
  for (const agentId of candidateIds) {
    const agent = await findAgentById(getDb(), agentId);
    if (!agent || agent.author !== automation.ownerAccountId) continue;
    try {
      const assignments = await getOxyAgentCapabilityMap({
        requesterAccountId: automation.ownerAccountId,
        ownerAccountId: automation.ownerAccountId,
        actor: { type: 'agent', accountId: agent.oxyAccountId },
        autonomy: 'autonomous',
      });
      if (!assignmentsCoverAutomation({ assignments, sourceResources, actions: automation.actions })) continue;
      if (automation.executionMode === 'execute' && !await automationHasActiveAuthorizationCoverage(
        getDb(),
        automation.id,
        agent.id,
        automation.actions.map((action) => action.id),
      )) continue;
      return agent;
    } catch (error: unknown) {
      log.triggers.warn(
        { err: error, agentId, ownerAccountId: automation.ownerAccountId },
        'Agent capability-map lookup failed closed',
      );
    }
  }
  return null;
}

async function notifyNoExecution(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
  reason: string,
): Promise<void> {
  await sendNotification({
    userId: automation.ownerAccountId,
    type: 'oxy_service',
    title: `${trigger.kind === 'event' ? trigger.appId : 'Scheduled'} automation did not run`,
    body: reason,
    priority: 'normal',
    channels: ['in_app', 'push'],
    data: { automationId: automation.id, triggerId: trigger.id, triggerKind: trigger.kind },
  });
}

function taskFor(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
): string {
  const triggerContext = trigger.kind === 'event'
    ? {
        type: 'event',
        eventId: trigger.id,
        appId: trigger.appId,
        eventType: trigger.eventType,
        occurredAt: trigger.occurredAt.toISOString(),
        resource: trigger.resource,
        data: trigger.data,
      }
    : {
        type: 'schedule',
        occurrenceId: trigger.id,
        occurredAt: trigger.occurredAt.toISOString(),
      };
  return [
    automation.objective,
    '',
    'This run was started by a normalized Oxy automation. Use only the declared actions and minimum trigger data below.',
    JSON.stringify({
      trigger: triggerContext,
      inputs: automation.inputs,
      actions: automation.actions.map((action) => ({
        resource: action.resource,
        tool: action.tool,
        input: action.input,
      })),
    }),
  ].join('\n');
}

function primaryResource(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
  sourceResources: readonly AutomationResourceRef[],
): AutomationResourceRef {
  if (trigger.kind === 'event') return trigger.resource;
  return sourceResources[0] ?? automation.actions[0]?.resource ?? {
    appId: 'alia',
    effectiveAccountId: automation.ownerAccountId,
    resourceType: 'automation',
    resourceId: automation.id,
  };
}

export async function dispatchStructuredAutomation(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
): Promise<AutomationDispatchResult> {
  if (!automation.enabled) return { status: 'denied', reason: 'automation_disabled' };
  if (automation.maximumAutonomy !== 'autonomous') {
    const reason = `“${automation.objective}” needs approval under its ${automation.maximumAutonomy} policy.`;
    await notifyNoExecution(automation, trigger, reason);
    return { status: 'denied', reason: 'autonomy_requires_approval' };
  }

  const sourceResources = uniqueResources([
    ...(trigger.kind === 'event' ? [trigger.resource] : []),
    ...automation.dataFlow.sources,
  ]);
  const agent = await eligibleAgent(automation, sourceResources);
  if (!agent) {
    const reason = 'No eligible agent currently covers every source resource and declared action.';
    await notifyNoExecution(automation, trigger, reason);
    return { status: 'denied', reason: 'no_eligible_agent' };
  }

  const resource = primaryResource(automation, trigger, sourceResources);
  if (automation.executionMode === 'observe') {
    const created = await createObservedAutomationRun({
      db: getDb(),
      automationId: automation.id,
      requesterAccountId: automation.ownerAccountId,
      selectedAgentId: agent.id,
      selectedActorAccountId: agent.oxyAccountId,
      triggerEventId: trigger.id,
      resource,
      objective: automation.objective,
      actions: automation.actions,
    });
    return { status: created ? 'observed' : 'duplicate' };
  }

  const task = taskFor(automation, trigger);
  const session = await createAgentSession(getDb(), {
    agentId: agent.id,
    oxyUserId: automation.ownerAccountId,
    task,
    status: 'queued',
    messages: [{ role: 'user', content: task, timestamp: new Date() }],
  });
  const claimed = await createAutomationRunForSession({
    db: getDb(),
    sessionId: session.id,
    automationId: automation.id,
    requesterAccountId: automation.ownerAccountId,
    selectedAgentId: agent.id,
    selectedActorAccountId: agent.oxyAccountId,
    triggerEventId: trigger.id,
    resource,
    objective: automation.objective,
    actions: automation.actions,
  });
  if (!claimed) {
    await updateAgentSession(getDb(), session.id, {
      status: 'cancelled',
      result: 'Duplicate automation occurrence',
    });
    return { status: 'duplicate' };
  }
  try {
    await enqueueAgentSession({
      sessionId: session.id,
      userId: automation.ownerAccountId,
      agentId: agent.id,
      agentName: `Agent ${agent.id}`,
    });
  } catch (error: unknown) {
    await Promise.all([
      updateAgentSession(getDb(), session.id, { status: 'failed', result: 'Could not queue automation run' }),
      markAutomationRunForSession(getDb(), session.id, 'failed'),
    ]);
    throw error;
  }
  return { status: 'queued', sessionId: session.id };
}
