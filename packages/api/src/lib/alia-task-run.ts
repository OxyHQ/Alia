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
 * Failure: a job that throws is retried by the queue with its hold intact. On
 * the last attempt the hold is refunded, the run is marked failed and the
 * person is told — in the task's conversation, or by notification if even
 * that is out of reach.
 */

import { generateText, stepCountIs } from 'ai';
import type { User as OxyUser } from '@oxy.so/core';
import { getDb } from '../db/index.js';
import {
  findAutomationDefinitionById,
  findAutomationRunById,
  listAutomationRunSteps,
  markAliaAutomationRun,
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
import { userContextBlock } from './user-context.js';

/** Model steps one run may take: room to search, read and answer, not to wander. */
export const ALIA_TASK_MAX_STEPS = 10;

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
    await Promise.all([
      markAliaAutomationRun(getDb(), data.runId, 'failed'),
      safeRefund(data.creditReservation, 'Alia task definition not found'),
    ]);
    return 'failed';
  }

  let settled = false;
  try {
    const steps = await listAutomationRunSteps(getDb(), data.runId);
    const control = steps.find((step) => step.tool === 'alia.run');
    if (!control) throw new Error('Alia task run has no control step');
    const task = renderAutomationStageTask(control.input);
    await markAliaAutomationRun(getDb(), data.runId, 'running');

    const [{ oxyUser, memory }, resolved] = await Promise.all([
      loadPersonContext(data.userId),
      resolveDefaultModel(),
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
    });
    const systemPrompt = `${buildIdentityGuard()}\n\n---\n\n${buildAliaTaskSystemPrompt(oxyUser, memory)}`;

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
    });

    // Every step, not only the last: a run that searched three times spent that.
    const usage: CreditUsage = {
      promptTokens: result.totalUsage.inputTokens ?? 0,
      completionTokens: result.totalUsage.outputTokens ?? 0,
      totalTokens: (result.totalUsage.inputTokens ?? 0) + (result.totalUsage.outputTokens ?? 0),
    };
    try {
      await finalizeCredits(data.creditReservation, usage, servedModelId(resolved.modelId, servedReferenceOf(result)));
      settled = true;
    } catch (err: unknown) {
      log.agents.error({ err, runId: data.runId }, 'Could not settle an Alia task run');
      // Unsettled, therefore refunded: the person is not charged the full hold.
      await safeRefund(data.creditReservation, 'Alia task settlement failed');
      settled = true;
    }
    await markAliaAutomationRun(getDb(), data.runId, 'succeeded');

    try {
      await postAliaMessage({
        oxyUserId: data.userId,
        automationId: automation.id,
        objective: automation.objective,
        conversationId: automation.conversationId,
        content: result.text.trim() || 'Task finished.',
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
    await Promise.all([
      safeRefund(data.creditReservation, 'Alia task failed'),
      markAliaAutomationRun(getDb(), data.runId, 'failed'),
    ]);
    await notifyFailure(data, automation);
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
