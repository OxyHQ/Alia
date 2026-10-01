/** Shared policy, actor selection and queueing for normalized automations. */

import { uuidv7 } from '@oxy.so/db';
import type { AutomationDefinitionRecord } from '../db/automation/automationDefinitionRepository.js';
import {
  claimAutomationRunPlan,
  createObservedAutomationRun,
  listActiveAutomationAuthorizations,
  markAliaAutomationRun,
  markAutomationRunForSession,
  setAutomationEnabled,
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
import { automationExecutionPolicyError } from './automation-execution-policy.js';
import { enqueueAgentSession } from './task-queue.js';
import { enqueueAliaTask } from './alia-task-queue.js';
import { mayRunForAutomationOwner } from './automation-actors.js';
import { reserveCredits, safeRefund, type CreditReservation } from './credits-manager.js';
import { listActiveAliaTaskAuthorizations } from '../db/automation/aliaTaskAuthorityRepository.js';
import {
  findAutomationWatchState,
  pauseFailingAutomationWatch,
  recordAutomationWatchFailure,
  recordAutomationWatchObservation,
} from '../db/automation/automationWatchRepository.js';
import {
  decideWatch,
  observeWatchSource,
  watchConfigOf,
  watchTriggerContext,
  watchTriggerId,
  WATCH_PAUSE_AFTER_FAILURES,
  type WatchConfig,
  type WatchObservation,
} from './alia-watch.js';
import { log } from './logger.js';
import { getOrCreateUserCredits } from './user-credits-helpers.js';

export type AutomationDispatchTrigger =
  | {
      kind: 'manual';
      id: string;
      occurredAt: Date;
      requesterAccountId: string;
    }
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
      /**
       * Set when a watch's cheap tick saw its condition met: what changed,
       * for the model run it starts (`lib/alia-watch.ts`).
       */
      watch?: Record<string, unknown>;
    };

export type AutomationDispatchResult =
  /** `sessionId` is the first stage's agent session; an Alia run has none. */
  | { status: 'queued'; runId: string; sessionId?: string }
  | { status: 'observed' }
  /** A watch's cheap tick saw nothing that crosses its condition. */
  | { status: 'unchanged' }
  | { status: 'duplicate' }
  | { status: 'denied'; reason: string };

/** The agents this automation may run — see {@link mayRunForAutomationOwner}. */
async function eligibleAgents(automation: AutomationDefinitionRecord) {
  const selection = automation.actorSelection;
  const candidateIds = selection.mode === 'fixed'
    ? [selection.agentId].filter((id): id is string => Boolean(id))
    : selection.mode === 'automatic' ? selection.eligibleAgentIds : [];
  const agents = await Promise.all(candidateIds.map((agentId) => findAgentById(getDb(), agentId)));
  return agents.filter((agent): agent is NonNullable<typeof agent> => (
    agent !== null && mayRunForAutomationOwner(agent, automation.ownerAccountId)
  ));
}

/**
 * Hold credits for an automation run BEFORE it is claimed, as a goal does.
 *
 * Automation sessions used to carry no reservation, so the runner's
 * `finalizeCredits` had nothing to settle and every scheduled run — including
 * one that runs somebody else's public agent — was free. The hold is the
 * default one; the runner settles it against the tokens actually spent.
 */
async function reserveAutomationRun(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
): Promise<CreditReservation | null> {
  await getOrCreateUserCredits(automation.ownerAccountId);
  const reservation = await reserveCredits(automation.ownerAccountId);
  if (!reservation) {
    await notifyNoExecution(automation, trigger, 'Not enough credits to run this task.');
  }
  return reservation;
}

async function notifyNoExecution(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
  reason: string,
): Promise<void> {
  const source = trigger.kind === 'event'
    ? trigger.appId
    : trigger.kind === 'schedule'
      ? 'Scheduled'
      : 'Manual';
  await sendNotification({
    userId: automation.ownerAccountId,
    type: 'oxy_service',
    title: `${source} automation did not run`,
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
  if (trigger.kind === 'manual' && trigger.requesterAccountId !== automation.ownerAccountId) {
    return { status: 'denied', reason: 'manual_requester_not_owner' };
  }
  if (trigger.kind !== automation.trigger.type) {
    return { status: 'denied', reason: 'automation_trigger_mismatch' };
  }
  if (!automation.enabled) return { status: 'denied', reason: 'automation_disabled' };
  const executionPolicyError = automationExecutionPolicyError({
    enabled: automation.enabled,
    executionMode: automation.executionMode,
    maximumAutonomy: automation.maximumAutonomy,
    triggerType: trigger.kind,
  });
  if (executionPolicyError) {
    const reason = `“${automation.objective}” needs approval under its ${automation.maximumAutonomy} policy.`;
    await notifyNoExecution(automation, trigger, reason);
    return { status: 'denied', reason: executionPolicyError };
  }

  const requiredAutonomy = automation.executionMode === 'observe' || trigger.kind === 'manual'
    ? automation.maximumAutonomy
    : 'autonomous';
  const sourceResources = uniqueAutomationResources([
    ...(trigger.kind === 'event' ? [trigger.resource] : []),
    ...automation.dataFlow.sources,
  ]);
  if (automation.actorSelection.mode === 'alia') {
    const watch = watchConfigOf(automation.inputs);
    if (watch && automation.executionMode === 'execute' && trigger.kind === 'schedule' && !trigger.watch) {
      return tickAliaWatch(automation, trigger, watch, sourceResources);
    }
    return dispatchAliaTask(automation, trigger, sourceResources);
  }
  const agents = await eligibleAgents(automation);
  if (automation.actions.length === 0) {
    const agent = agents[0];
    if (!agent) {
      const reason = 'The responsible agent is unavailable.';
      await notifyNoExecution(automation, trigger, reason);
      return { status: 'denied', reason: 'responsible_agent_unavailable' };
    }
    const resource = primaryResource(automation, trigger, sourceResources);
    const stages = [{
      stage: 0,
      agentId: agent.id,
      actorAccountId: agent.oxyAccountId,
      actions: [],
    }];
    const requesterAccountId = trigger.kind === 'manual'
      ? trigger.requesterAccountId
      : automation.ownerAccountId;
    const taskInputs = automationStageTaskInputs(automation, trigger, stages);
    const runStages = [{
      stage: 0,
      selectedAgentId: agent.id,
      selectedActorAccountId: agent.oxyAccountId,
      resource,
      taskInput: taskInputs[0] ?? {},
      actions: [],
    }];
    if (automation.executionMode === 'observe') {
      const created = await createObservedAutomationRun({
        db: getDb(),
        automationId: automation.id,
        requesterAccountId,
        triggerEventId: trigger.id,
        stages: runStages,
      });
      return { status: created ? 'observed' : 'duplicate' };
    }
    const reservation = await reserveAutomationRun(automation, trigger);
    if (!reservation) return { status: 'denied', reason: 'insufficient_credits' };
    const runId = uuidv7();
    const session = await getDb().transaction(async (transaction) => {
      const claimed = await claimAutomationRunPlan({
        db: transaction,
        runId,
        automationId: automation.id,
        requesterAccountId,
        triggerEventId: trigger.id,
        stages: runStages,
      });
      if (!claimed) return null;
      if (automation.inputs.runOnce === true) {
        const disabled = await setAutomationEnabled(
          transaction,
          automation.id,
          automation.ownerAccountId,
          false,
        );
        if (!disabled) throw new Error('Claimed one-off task could not be disabled');
      }
      const task = renderAutomationStageTask(taskInputs[0] ?? {});
      return createAgentSession(transaction, {
        agentId: agent.id,
        oxyUserId: automation.ownerAccountId,
        automationRunId: runId,
        automationStage: 0,
        task,
        status: 'queued',
        messages: [{ role: 'user', content: task, timestamp: new Date() }],
        creditReservation: reservation,
      });
    });
    if (!session) {
      await safeRefund(reservation, 'duplicate automation run');
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
        safeRefund(reservation, 'automation run could not be queued'),
      ]);
      throw error;
    }
    return { status: 'queued', runId, sessionId: session.id };
  }
  const candidates = await loadAutomationActorCandidates(
    automation.ownerAccountId,
    agents,
    requiredAutonomy,
  );
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
    requiredAutonomy,
  });
  if (!stages || stages.length === 0) {
    const reason = 'No deterministic actor plan currently covers the source resources and every declared action.';
    await notifyNoExecution(automation, trigger, reason);
    return { status: 'denied', reason: 'no_eligible_actor_plan' };
  }

  const resource = primaryResource(automation, trigger, sourceResources);
  const requesterAccountId = trigger.kind === 'manual'
    ? trigger.requesterAccountId
    : automation.ownerAccountId;
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
      requesterAccountId,
      triggerEventId: trigger.id,
      stages: runStages,
    });
    return { status: created ? 'observed' : 'duplicate' };
  }

  const reservation = await reserveAutomationRun(automation, trigger);
  if (!reservation) return { status: 'denied', reason: 'insufficient_credits' };
  const runId = uuidv7();
  const session = await getDb().transaction(async (transaction) => {
    const claimed = await claimAutomationRunPlan({
      db: transaction,
      runId,
      automationId: automation.id,
      requesterAccountId,
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
      creditReservation: reservation,
    });
  });
  if (!session) {
    await safeRefund(reservation, 'duplicate automation run');
    return { status: 'duplicate' };
  }
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
      safeRefund(reservation, 'automation run could not be queued'),
    ]);
    throw error;
  }
  return { status: 'queued', runId, sessionId: session.id };
}

/**
 * One cheap tick of a watch task: observe the source with no model, and only
 * when the condition is crossed hand a run to {@link dispatchAliaTask} with
 * the change attached. See `lib/alia-watch.ts`.
 */
async function tickAliaWatch(
  automation: AutomationDefinitionRecord,
  trigger: Extract<AutomationDispatchTrigger, { kind: 'schedule' }>,
  watch: WatchConfig,
  sourceResources: readonly AutomationResourceRef[],
): Promise<AutomationDispatchResult> {
  const now = new Date();
  const state = await findAutomationWatchState(getDb(), automation.id);
  if (state?.nextCheckAt && state.nextCheckAt > now) {
    return { status: 'denied', reason: 'watch_backing_off' };
  }
  let observation: WatchObservation;
  try {
    observation = await observeWatchSource(watch);
  } catch (error: unknown) {
    const failures = await recordAutomationWatchFailure(getDb(), automation.id, now);
    log.triggers.warn({ err: error, automationId: automation.id, failures }, 'Watch tick failed');
    if (failures >= WATCH_PAUSE_AFTER_FAILURES
      && await pauseFailingAutomationWatch(getDb(), automation.id, WATCH_PAUSE_AFTER_FAILURES, now)) {
      // One notification per failure streak: only the caller that paused it.
      await notifyNoExecution(
        automation,
        trigger,
        `I paused “${automation.objective}”: I could not check its source ${WATCH_PAUSE_AFTER_FAILURES} times in a row. Turn it back on to resume.`,
      );
      return { status: 'denied', reason: 'watch_paused' };
    }
    return { status: 'denied', reason: 'watch_source_failed' };
  }
  const decision = decideWatch(watch, state, observation);
  const record = () => recordAutomationWatchObservation(getDb(), {
    automationId: automation.id,
    hash: observation.hash,
    items: observation.items,
    matched: decision.matched,
    changed: decision.changed,
    now,
  });
  if (!decision.fire) {
    await record();
    return { status: 'unchanged' };
  }
  const result = await dispatchAliaTask(automation, {
    kind: 'schedule',
    id: watchTriggerId(automation.id, observation.hash),
    occurredAt: now,
    watch: watchTriggerContext(watch, observation, decision),
  }, sourceResources);
  // A run that could not be claimed (no credits) leaves the state alone, so
  // the next tick sees the same change and tries again.
  if (result.status === 'queued' || result.status === 'duplicate') await record();
  return result;
}

/**
 * A task Alia is responsible for: no agent, no session. The run is claimed with
 * Alia as its actor and handed to the `alia-tasks` queue, whose job runs one
 * Alia turn for the owner and posts the answer into the task's conversation.
 *
 * Declared connected actions run under Alia's own standing Oxy authority
 * (`alia_task_authorizations`, provisioned while the owner was present). In
 * execute mode every declared action must still be covered, or nothing runs.
 */
async function dispatchAliaTask(
  automation: AutomationDefinitionRecord,
  trigger: AutomationDispatchTrigger,
  sourceResources: readonly AutomationResourceRef[],
): Promise<AutomationDispatchResult> {
  if (automation.actions.length > 0 && automation.executionMode === 'execute') {
    const covered = new Set((await listActiveAliaTaskAuthorizations(getDb(), automation.id))
      .flatMap((authorization) => authorization.automationActionId ? [authorization.automationActionId] : []));
    if (!automation.actions.every((action) => covered.has(action.id))) {
      await notifyNoExecution(
        automation,
        trigger,
        `“${automation.objective}” no longer has access to the apps it acts in. Open the task and save it again to renew it.`,
      );
      return { status: 'denied', reason: 'alia_action_authority_missing' };
    }
  }
  const requesterAccountId = trigger.kind === 'manual'
    ? trigger.requesterAccountId
    : automation.ownerAccountId;
  const [taskInput = {}] = automationStageTaskInputs(automation, trigger, [{ actions: automation.actions }]);
  const runStages = [{
    stage: 0,
    selectedAgentId: null,
    selectedActorAccountId: automation.ownerAccountId,
    resource: primaryResource(automation, trigger, sourceResources),
    taskInput,
    actions: automation.actions,
  }];
  if (automation.executionMode === 'observe') {
    const created = await createObservedAutomationRun({
      db: getDb(),
      automationId: automation.id,
      requesterAccountId,
      triggerEventId: trigger.id,
      stages: runStages,
      actorType: 'alia',
    });
    return { status: created ? 'observed' : 'duplicate' };
  }

  const reservation = await reserveAutomationRun(automation, trigger);
  if (!reservation) return { status: 'denied', reason: 'insufficient_credits' };
  const runId = uuidv7();
  const claimed = await getDb().transaction(async (transaction) => {
    const inserted = await claimAutomationRunPlan({
      db: transaction,
      runId,
      automationId: automation.id,
      requesterAccountId,
      triggerEventId: trigger.id,
      stages: runStages,
      actorType: 'alia',
      creditReservation: reservation,
    });
    if (!inserted) return false;
    if (automation.inputs.runOnce === true) {
      const disabled = await setAutomationEnabled(
        transaction,
        automation.id,
        automation.ownerAccountId,
        false,
      );
      if (!disabled) throw new Error('Claimed one-off task could not be disabled');
    }
    return true;
  });
  if (!claimed) {
    await safeRefund(reservation, 'duplicate automation run');
    return { status: 'duplicate' };
  }
  try {
    await enqueueAliaTask({
      runId,
      automationId: automation.id,
      userId: automation.ownerAccountId,
      creditReservation: reservation,
    });
  } catch (error: unknown) {
    await Promise.all([
      markAliaAutomationRun(getDb(), runId, 'failed'),
      safeRefund(reservation, 'automation run could not be queued'),
    ]);
    throw error;
  }
  return { status: 'queued', runId };
}
