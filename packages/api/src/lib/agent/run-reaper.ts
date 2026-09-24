/**
 * The sweep that keeps background agent runs from being lost.
 *
 * A run is owned by the worker that claimed it, through a lease the worker
 * renews while it works (`claimAgentSessionRun`, `runner.ts`). When the worker
 * dies — a crash, an OOM, a deploy replacing the task — the lease lapses and
 * nobody drives the run: before leases the row sat in `running` forever,
 * holding its credits and one of the agent's admission slots.
 *
 * Every minute this hands each lapsed run back to the queue, where the next
 * worker to claim it RESUMES it from its persisted events and counters. A run
 * that has already lost its worker `RUNNER_MAX_ATTEMPTS` times is failed and
 * refunded instead, because something about it keeps killing workers.
 *
 * Not leader-gated. Resuming is idempotent by construction — the resume job's
 * id names the attempt, so N tasks enqueueing it produce one job, and the claim
 * is a single conditional UPDATE — and failing is a conditional UPDATE that
 * returns the row to exactly one caller, which is the one that refunds.
 */

import { getDb } from '../../db/index.js';
import {
  failExhaustedAgentSessionRun,
  listLapsedAgentSessionRuns,
  RUNNER_MAX_ATTEMPTS,
} from '../../db/agents/agentSessionRepository.js';
import { expireAgentApprovals } from '../../db/agents/agentRuntimeRepository.js';
import { markAutomationRunForSession } from '../../db/automation/automationDefinitionRepository.js';
import { safeRefund } from '../credits-manager.js';
import { log } from '../logger.js';
import { sendNotification } from '../notification-service.js';
import { enqueueAgentSession } from '../task-queue.js';
import { reclaimOrphanedAgentSessions } from './session-handoff.js';

const REAP_EVERY_MS = 60_000;

export interface ReapResult {
  resumed: number;
  failed: number;
}

export async function reapAgentRuns(now: Date = new Date()): Promise<ReapResult> {
  const result: ReapResult = { resumed: 0, failed: 0 };
  const lapsed = await listLapsedAgentSessionRuns(getDb(), now);
  for (const run of lapsed) {
    try {
      if (run.attempts >= RUNNER_MAX_ATTEMPTS) {
        const failed = await failExhaustedAgentSessionRun(getDb(), run.id, now);
        if (!failed) continue;
        result.failed++;
        if (failed.creditReservation) await safeRefund(failed.creditReservation, 'run interrupted too many times');
        await markAutomationRunForSession(getDb(), run.id, 'failed');
        await sendNotification({
          userId: run.oxyUserId,
          type: 'agent_task_complete',
          title: 'A task could not finish',
          body: 'It was interrupted too many times and was stopped. Your credits were returned.',
          data: { sessionId: run.id, agentId: run.agentId, status: 'failed' },
        }).catch((err: unknown) => log.agents.warn({ err, sessionId: run.id }, 'Could not notify an exhausted run'));
        continue;
      }
      await enqueueAgentSession(
        { sessionId: run.id, userId: run.oxyUserId, agentId: run.agentId, agentName: `Agent ${run.agentId}` },
        { resumeAttempt: run.attempts },
      );
      result.resumed++;
    } catch (err: unknown) {
      log.agents.error({ err, sessionId: run.id }, 'Could not reap a lapsed agent run');
    }
  }
  if (result.resumed > 0 || result.failed > 0) {
    log.agents.warn(result, 'Reaped agent runs whose worker stopped');
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

async function sweep(): Promise<void> {
  await reapAgentRuns().catch((err: unknown) => log.agents.error({ err }, '[AgentRun] Reap error'));
  // Sessions queued and never picked up, and approvals nobody answered: the
  // same "nothing will ever settle this" event, so the same sweep. Both are
  // single conditional UPDATEs and safe on every task.
  await reclaimOrphanedAgentSessions()
    .catch((err: unknown) => log.agents.error({ err }, '[AgentSession] Orphan reclaim error'));
  await expireAgentApprovals(getDb())
    .catch((err: unknown) => log.agents.error({ err }, '[AgentApproval] Expiry error'));
}

export function startAgentRunReaper(): void {
  if (timer) return;
  void sweep();
  timer = setInterval(() => void sweep(), REAP_EVERY_MS);
  timer.unref?.();
}

export function stopAgentRunReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
