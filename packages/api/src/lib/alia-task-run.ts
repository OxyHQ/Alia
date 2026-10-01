/**
 * One run of a scheduled task whose responsible actor is Alia.
 *
 * Alia is the default actor of every task; agents are optional. Such a run has
 * no agent session: the dispatcher claims the run with Alia as its actor, holds
 * the owner's credits and queues this job (`alia-task-queue.ts`). Here Alia
 * takes one unattended turn for the owner — the same composition as the
 * service-trigger path in `routes/internal.ts`: the `auto` power level, the
 * one tool assembler with no agent — then settles the hold against the tokens
 * spent, closes the run and posts the answer into the task's own conversation
 * (`postAliaMessage`).
 *
 * Authority: Alia acts for the owner in their Oxy apps with the standing
 * authority provisioned when the task was created or edited
 * (`alia_task_authorizations`): every read tool of their apps, repeatable, and
 * each declared connected action once, correlated with its run step. A task
 * without it (created before it existed, or by an API-key caller) gets no Oxy
 * app tools rather than tools that are refused.
 *
 * Watch runs (`lib/alia-watch.ts`) carry the observed change in their trigger
 * and may conclude it is not worth telling the person: they reply
 * {@link WATCH_NOTHING_TO_REPORT} and nothing is posted.
 *
 * Failure: a job that throws is retried by the queue with its hold intact. On
 * the last attempt the hold is refunded, the run is marked failed and the
 * person is told — in the task's conversation, or by notification if even
 * that is out of reach. A run whose worker vanished is failed and refunded by
 * `alia-task-reaper.ts` once its lease lapses; every settlement here is
 * conditional on the run still being open, so the two never both refund.
 */

import { generateText, stepCountIs } from 'ai';
import type { User as OxyUser } from '@oxy.so/core';
import { getDb } from '../db/index.js';
import { listAliaTaskAuthorizationsForRun } from '../db/automation/aliaTaskAuthorityRepository.js';
import {
  findAutomationDefinitionById,
  findAutomationRunById,
  listAutomationRunSteps,
  markAliaAutomationRun,
  markAutomationActionStep,
} from '../db/automation/automationDefinitionRepository.js';
import { findUserMemory, type UserMemoryProfile } from '../db/memory/userMemoryRepository.js';
import { oxyClient } from '../middleware/auth.js';
import { postAliaMessage } from './agent/alia-outreach.js';
import type { AliaTaskJobData } from './alia-task-queue.js';
import { renderAutomationStageTask } from './automation-stage-task.js';
import { getAIModel, resolveDefaultModel } from './chat-core.js';
import { finalizeCredits, safeRefund, type CreditUsage } from './credits-manager.js';
import { servedModelId, servedReferenceOf } from './models/power-levels.js';
import { buildIdentityGuard } from './identity-guard.js';
import { log } from './logger.js';
import { sendNotification } from './notification-service.js';
import { ToolPipeline } from './tool-pipeline.js';
import { oxyExecutionAuthorizationKey, type OxyExecutionAuthorizationRef } from './tools/oxy-services.js';
import { userContextBlock } from './user-context.js';

/** Model steps one run may take: room to search, read and answer, not to wander. */
export const ALIA_TASK_MAX_STEPS = 10;

/** The longest one run's model turn may take before it is aborted. */
export const ALIA_TASK_TIMEOUT_MS = 10 * 60_000;
/**
 * How long a started run is presumed to have a live worker. Longer than
 * {@link ALIA_TASK_TIMEOUT_MS} plus settlement, so only a vanished worker
 * lets it lapse.
 */
export const ALIA_TASK_LEASE_MS = 15 * 60_000;

/** A watch run's whole reply when the change is not worth telling anyone. */
export const WATCH_NOTHING_TO_REPORT = 'NOTHING_TO_REPORT';

const WATCH_GUIDELINES = `

## This run was started by a watch

The source this task watches changed; \`trigger.watch\` below says what changed. Decide whether it is something the person asked to hear about.
- If it is, tell them what is new, concisely, with links.
- If it is not (noise, a reshuffle, nothing relevant), reply exactly ${WATCH_NOTHING_TO_REPORT} and nothing else.`;

/** The authority map ToolPipeline takes, from the run's stored authorizations. */
export function aliaRunAuthorizationMap(
  authorizations: Awaited<ReturnType<typeof listAliaTaskAuthorizationsForRun>>,
): Record<string, OxyExecutionAuthorizationRef> {
  return Object.fromEntries(authorizations.map((authorization) => [
    oxyExecutionAuthorizationKey(authorization.resource, authorization.tool),
    {
      id: authorization.oxyAuthorizationId,
      ...(authorization.stepId ? { stepId: authorization.stepId } : {}),
      repeatable: authorization.repeatable,
    },
  ]));
}

function isWatchRun(input: Record<string, unknown>): boolean {
  const trigger = input.trigger;
  return typeof trigger === 'object' && trigger !== null && 'watch' in trigger;
}

const FAILURE_MESSAGE = "I couldn't complete this scheduled task this time.";

function buildAliaTaskSystemPrompt(oxyUser: OxyUser | null, memory: UserMemoryProfile | null): string {
  // Names nobody: `buildIdentityGuard` is prepended above this and owns that.
  const prompt = `You are running a scheduled task the person asked you to do, unattended. They are not in this conversation right now; they will read your answer later, in a conversation dedicated to this task.

## Guidelines

- Do the task now with the tools you have, then reply with the result for them: what you found or did, concisely.
- If there is nothing new or relevant to report, say so in one sentence.
- Do not ask questions you need answered to continue — nobody will answer during this run. State any assumption you made.
- Use the person's preferred language if known.`;
  return `${userContextBlock(oxyUser, memory)}${prompt}`;
}

async function loadPersonContext(userId: string): Promise<{ oxyUser: OxyUser | null; memory: UserMemoryProfile | null }> {
  const [memory, oxyUser] = await Promise.all([
    findUserMemory(getDb(), userId).then((found) => found ?? null).catch((err: unknown) => {
      log.agents.warn({ err }, 'Could not load memory for an Alia task');
      return null;
    }),
    (oxyClient.users.get(userId) as Promise<OxyUser>).catch((err: unknown) => {
      log.agents.info({ err }, 'Could not fetch the Oxy profile for an Alia task');
      return null;
    }),
  ]);
  return { oxyUser, memory };
}

/**
 * Run one queued Alia task. Returns `skipped` for a run that is not this
 * job's to drive (gone, not Alia's, or already settled); throws for a failure
 * the queue may retry.
 */
export async function runAliaTask(
  data: AliaTaskJobData,
  options: { finalAttempt: boolean },
): Promise<'completed' | 'failed' | 'skipped'> {
  const run = await findAutomationRunById(getDb(), data.runId);
  if (!run || run.selectedActorType !== 'alia') {
    await safeRefund(data.creditReservation, 'Alia task run not found');
    return 'skipped';
  }
  if (run.status !== 'planned' && run.status !== 'running') return 'skipped';

  const automation = await findAutomationDefinitionById(getDb(), run.automationId);
  if (!automation || automation.ownerAccountId !== data.userId) {
    if (await markAliaAutomationRun(getDb(), data.runId, 'failed')) {
      await safeRefund(data.creditReservation, 'Alia task definition not found');
    }
    return 'failed';
  }

  let settled = false;
  try {
    const steps = await listAutomationRunSteps(getDb(), data.runId);
    const control = steps.find((step) => step.tool === 'alia.run');
    if (!control) throw new Error('Alia task run has no control step');
    const task = renderAutomationStageTask(control.input);
    const watchRun = isWatchRun(control.input);
    // Also renews the lease on a retry. False: the reaper already closed it.
    if (!await markAliaAutomationRun(getDb(), data.runId, 'running', { leaseMs: ALIA_TASK_LEASE_MS })) {
      settled = true;
      return 'skipped';
    }

    const [{ oxyUser, memory }, resolved, authorizations] = await Promise.all([
      loadPersonContext(data.userId),
      resolveDefaultModel(),
      listAliaTaskAuthorizationsForRun(getDb(), automation.id, data.runId),
    ]);
    const { tools, routing, appCatalogPrompt } = await ToolPipeline.forUser({
      userId: data.userId,
      isDirectSession: false,
      // Alia acts for the task's owner, who asked for it.
      actsForPerson: true,
      agentMode: false,
      agent: null,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: false,
      runId: data.runId,
      oxyAutonomy: automation.maximumAutonomy,
      // Exactly her standing authority; `{}` (none) builds no Oxy tools.
      oxyExecutionAuthorizations: aliaRunAuthorizationMap(authorizations),
      onOxyStepStatus: async (stepId, status, auditEventId) => {
        try {
          await markAutomationActionStep(getDb(), stepId, status, auditEventId);
        } catch (err: unknown) {
          log.agents.warn({ err, runId: data.runId, stepId, status }, 'Could not record an Alia task step');
        }
      },
    });
    const systemPrompt = `${buildIdentityGuard()}\n\n---\n\n${buildAliaTaskSystemPrompt(oxyUser, memory)}${watchRun ? WATCH_GUIDELINES : ''}`;

    const result = await generateText({
      model: getAIModel(resolved, 'trigger'),
      messages: [
        { role: 'system', content: systemPrompt + appCatalogPrompt },
        { role: 'user', content: task },
      ],
      tools,
      // Bounds each request to the per-request tool budget (`lib/tool-budget.ts`).
      ...routing,
      temperature: 0.3,
      // The queue retries the whole run; a retry here would double-spend.
      maxRetries: 0,
      stopWhen: stepCountIs(ALIA_TASK_MAX_STEPS),
      abortSignal: AbortSignal.timeout(ALIA_TASK_TIMEOUT_MS),
    });

    // Every step, not only the last: a run that searched three times spent that.
    const usage: CreditUsage = {
      promptTokens: result.totalUsage.inputTokens ?? 0,
      completionTokens: result.totalUsage.outputTokens ?? 0,
      totalTokens: (result.totalUsage.inputTokens ?? 0) + (result.totalUsage.outputTokens ?? 0),
    };
    // Closed first and conditionally: if the reaper failed this run while it
    // ran, it already refunded the hold and told the person.
    const closed = await markAliaAutomationRun(getDb(), data.runId, 'succeeded');
    settled = true;
    if (!closed) {
      log.agents.warn({ runId: data.runId }, 'Alia task finished after it was reaped; result dropped');
      return 'skipped';
    }
    try {
      await finalizeCredits(data.creditReservation, usage, servedModelId(resolved.modelId, servedReferenceOf(result)));
    } catch (err: unknown) {
      log.agents.error({ err, runId: data.runId }, 'Could not settle an Alia task run');
      // Unsettled, therefore refunded: the person is not charged the full hold.
      await safeRefund(data.creditReservation, 'Alia task settlement failed');
    }

    const reply = result.text.trim();
    if (watchRun && (reply === WATCH_NOTHING_TO_REPORT || reply.startsWith(WATCH_NOTHING_TO_REPORT))) {
      return 'completed';
    }
    try {
      await postAliaMessage({
        oxyUserId: data.userId,
        automationId: automation.id,
        objective: automation.objective,
        conversationId: automation.conversationId,
        content: reply || 'Task finished.',
      });
    } catch (err: unknown) {
      log.agents.warn({ err, runId: data.runId }, 'Failed to deliver an Alia task result');
    }
    return 'completed';
  } catch (err: unknown) {
    log.agents.error({ err, runId: data.runId }, 'Alia task run failed');
    // Already charged: a retry would run the task, and charge it, again.
    if (settled) return 'failed';
    if (!options.finalAttempt) throw err;
    // Only the caller that closes the run refunds it (see the reaper).
    if (await markAliaAutomationRun(getDb(), data.runId, 'failed')) {
      await safeRefund(data.creditReservation, 'Alia task failed');
      await notifyFailure(data, automation);
    }
    throw err;
  }
}

async function notifyFailure(
  data: AliaTaskJobData,
  automation: NonNullable<Awaited<ReturnType<typeof findAutomationDefinitionById>>>,
): Promise<void> {
  try {
    await postAliaMessage({
      oxyUserId: data.userId,
      automationId: automation.id,
      objective: automation.objective,
      conversationId: automation.conversationId,
      content: FAILURE_MESSAGE,
    });
  } catch (err: unknown) {
    log.agents.warn({ err, runId: data.runId }, 'Could not post an Alia task failure');
    await sendNotification({
      userId: data.userId,
      type: 'trigger_result',
      title: `“${automation.objective}” did not run`,
      body: FAILURE_MESSAGE,
      priority: 'high',
      channels: ['in_app', 'push'],
      data: { automationId: automation.id, runId: data.runId, status: 'failed' },
    }).catch((notifyErr: unknown) => log.agents.warn({ err: notifyErr }, 'Could not notify about a failed Alia task'));
  }
}
