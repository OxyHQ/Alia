/** Shared policy, actor selection and queueing for normalized automations. */

import { uuidv7 } from '@oxyhq/db';
import type { AutomationDefinitionRecord } from '../db/automation/automationDefinitionRepository.js';
import {
  claimAutomationRunPlan,
  createObservedAutomationRun,
  listActiveAutomationAuthorizations,
  markAutomationRunForSession,
} from '../db/automation/automationDefinitionRepository.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import { createAgentSession, updateAgentSession } from '../db/agents/agentSessionRepository.js';
import { getDb } from '../db/index.js';
import type { AutomationResourceRef } from '../db/schema/agency.js';
import {
  authorizationPairKey,
  loadAutomationActorCandidates,
  planAutomationStages,
  uniqueAutomationResources,
} from './automation-coordination.js';
import { sendNotification } from './notification-service.js';
import { automationStageTaskInputs, renderAutomationStageTask } from './automation-stage-task.js';
import { enqueueAgentSession } from './task-queue.js';

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

async function eligibleAgents(automation: AutomationDefinitionRecord) {
  const candidateIds = automation.actorSelection.mode === 'fixed'
    ? [automation.actorSelection.agentId].filter((id): id is string => Boolean(id))
    : automation.actorSelection.eligibleAgentIds;
  const agents = await Promise.all(candidateIds.map((agentId) => findAgentById(getDb(), agentId)));
  return agents.filter((agent): agent is NonNullable<typeof agent> => (
    agent !== null && agent.author === automation.ownerAccountId
  ));
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

  const sourceResources = uniqueAutomationResources([
    ...(trigger.kind === 'event' ? [trigger.resource] : []),
    ...automation.dataFlow.sources,
  ]);
  const agents = await eligibleAgents(automation);
  const candidates = await loadAutomationActorCandidates(automation.ownerAccountId, agents);
  const activeAuthorizationPairs = automation.executionMode === 'execute'
    ? new Set((await listActiveAutomationAuthorizations(getDb(), automation.id)).map((authorization) => (
        authorizationPairKey(authorization.automationActionId, authorization.agentId)
      )))
    : undefined;
  const stages = planAutomationStages({
    candidates,
    sourceResources,
    actions: automation.actions,
    activeAuthorizationPairs,
  });
  if (!stages || stages.length === 0) {
    const reason = 'No deterministic actor plan currently covers the source resources and every declared action.';
    await notifyNoExecution(automation, trigger, reason);
    return { status: 'denied', reason: 'no_eligible_actor_plan' };
  }

  const resource = primaryResource(automation, trigger, sourceResources);
  const taskInputs = automationStageTaskInputs(automation, trigger, stages);
  const runStages = stages.map((stage, index) => ({
    stage: stage.stage,
    selectedAgentId: stage.agentId,
    selectedActorAccountId: stage.actorAccountId,
    resource: stage.actions[0]?.resource ?? resource,
    taskInput: taskInputs[index] ?? {},
    actions: stage.actions,
  }));
  if (automation.executionMode === 'observe') {
    const created = await createObservedAutomationRun({
      db: getDb(),
      automationId: automation.id,
      requesterAccountId: automation.ownerAccountId,
      triggerEventId: trigger.id,
      stages: runStages,
    });
    return { status: created ? 'observed' : 'duplicate' };
  }

  const runId = uuidv7();
  const session = await getDb().transaction(async (transaction) => {
    const claimed = await claimAutomationRunPlan({
      db: transaction,
      runId,
      automationId: automation.id,
      requesterAccountId: automation.ownerAccountId,
      triggerEventId: trigger.id,
      stages: runStages,
    });
    if (!claimed) return null;
    const first = stages[0];
    const task = renderAutomationStageTask(taskInputs[0] ?? {});
    return createAgentSession(transaction, {
      agentId: first.agentId,
      oxyUserId: automation.ownerAccountId,
      automationRunId: runId,
      automationStage: first.stage,
      task,
      status: 'queued',
      messages: [{ role: 'user', content: task, timestamp: new Date() }],
    });
  });
  if (!session) return { status: 'duplicate' };
  try {
    await enqueueAgentSession({
      sessionId: session.id,
      userId: automation.ownerAccountId,
      agentId: session.agentId,
      agentName: `Agent ${session.agentId}`,
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
