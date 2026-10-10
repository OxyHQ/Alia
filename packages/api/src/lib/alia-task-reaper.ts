/**
 * The sweep that closes Alia task runs nobody will finish.
 *
 * An Alia run (`alia-task-run.ts`) has no agent session and no resumable
 * state: it is one model turn. Its worker takes a lease when it starts
 * (`ALIA_TASK_LEASE_MS`, longer than the turn's own timeout); a worker that
 * dies — a crash, an OOM, a deploy replacing the task — lets it lapse, and
 * before this sweep the run sat in `running` forever holding its credits. A
 * run whose job was lost before any worker took it sits in `planned` the same
 * way.
 *
 * Such a run is failed, its hold (kept on `automation_runs`) refunded and the
 * person told. Not resumed: re-running a turn that may already have acted in
 * an app is not safe, and the next occurrence of the task runs anyway.
 *
 * Not leader-gated: failing is a conditional UPDATE that returns the row to
 * exactly one caller, which is the one that refunds — and the runner's own
 * settlements are conditional on the run still being open, so a worker that
 * was only slow never settles a run this sweep already refunded.
 */

import { getDb } from '../db/index.js';
import {
  failAbandonedAliaRun,
  findAutomationDefinitionById,
  listAbandonedAliaRuns,
} from '../db/automation/automationDefinitionRepository.js';
import { postAliaMessage } from './agent/alia-outreach.js';
import { safeRefund } from './credits-manager.js';
import { log } from './logger.js';
import { sendNotification } from './notification-service.js';

/** A run still `planned` this long after dispatch was never picked up. */
export const ALIA_RUN_PICKUP_GRACE_MS = 30 * 60_000;

const INTERRUPTED_MESSAGE =
  "This scheduled task was interrupted and couldn't finish this time. Your credits were returned.";

export async function reapAbandonedAliaRuns(now: Date = new Date()): Promise<{ failed: number }> {
  const plannedBefore = new Date(now.getTime() - ALIA_RUN_PICKUP_GRACE_MS);
  const runIds = await listAbandonedAliaRuns(getDb(), now, plannedBefore);
  let failed = 0;
  for (const runId of runIds) {
    try {
      const run = await failAbandonedAliaRun(getDb(), runId, now, plannedBefore);
      if (!run) continue;
      failed++;
      if (run.creditReservation) await safeRefund(run.creditReservation, 'Alia task run abandoned');
      const automation = await findAutomationDefinitionById(getDb(), run.automationId);
      try {
        if (!automation) throw new Error('Alia task definition is gone');
        await postAliaMessage({
          oxyUserId: automation.ownerAccountId,
          automationId: automation.id,
          objective: automation.objective,
          conversationId: automation.conversationId,
          content: INTERRUPTED_MESSAGE,
        });
      } catch (err: unknown) {
        log.agents.warn({ err, runId }, 'Could not post an abandoned Alia run; notifying instead');
        await sendNotification({
          userId: automation?.ownerAccountId ?? run.requesterAccountId,
          type: 'trigger_result',
          title: automation
            ? `“${automation.objective}” did not finish`
            : 'A scheduled task did not finish',
          body: INTERRUPTED_MESSAGE,
          priority: 'normal',
          channels: ['in_app', 'push'],
          data: { automationId: run.automationId, runId, status: 'failed' },
        }).catch((notifyErr: unknown) =>
          log.agents.warn(
            { err: notifyErr, runId },
            'Could not notify about an abandoned Alia run',
          ),
        );
      }
    } catch (err: unknown) {
      log.agents.error({ err, runId }, 'Could not reap an abandoned Alia run');
    }
  }
  if (failed > 0) log.agents.warn({ failed }, 'Reaped Alia task runs nobody finished');
  return { failed };
}
