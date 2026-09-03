/** Elected cron scheduler for normalized automation definitions. */

import cron, { type ScheduledTask, type TaskContext } from 'node-cron';
import {
  findAutomationDefinitionById,
  listSchedulableAutomationDefinitions,
  listSchedulableAutomationVersions,
  type AutomationDefinitionRecord,
} from '../db/automation/automationDefinitionRepository.js';
import { getDb } from '../db/index.js';
import { dispatchStructuredAutomation } from './automation-dispatcher.js';
import {
  startLeaderElection,
  type LeaderElectionHandle,
  type LeaderElectionOptions,
} from './leader-election.js';
import { log } from './logger.js';

const scheduledTasks = new Map<string, ScheduledTask>();
const scheduledUpdatedAt = new Map<string, number>();
const RECONCILE_INTERVAL_MS = 30_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let electionHandle: LeaderElectionHandle | null = null;

export function automationScheduleError(
  cronExpression: string,
  timezone: string,
): 'invalid_cron' | 'invalid_timezone' | null {
  if (!cron.validate(cronExpression)) return 'invalid_cron';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return null;
  } catch {
    return 'invalid_timezone';
  }
}

function unscheduleAutomation(automationId: string): void {
  const existing = scheduledTasks.get(automationId);
  if (!existing) return;
  Promise.resolve(existing.stop()).catch((error: unknown) => {
    log.triggers.error({ err: error, automationId }, 'Failed to stop scheduled automation');
  });
  scheduledTasks.delete(automationId);
  scheduledUpdatedAt.delete(automationId);
}

function scheduleOccurrence(automationId: string, context: TaskContext) {
  const occurredAt = new Date(context.date);
  occurredAt.setMilliseconds(0);
  return {
    occurredAt,
    id: `schedule:${automationId}:${occurredAt.toISOString()}`,
  };
}

function scheduleAutomation(automation: AutomationDefinitionRecord): void {
  const automationId = automation.id;
  unscheduleAutomation(automationId);
  if (!automation.enabled || automation.trigger.type !== 'schedule') return;
  const cronExpression = automation.trigger.cron;
  const timezone = automation.trigger.timezone;
  if (!cronExpression || !timezone) {
    log.triggers.error({ automationId }, 'Automation schedule is incomplete');
    return;
  }
  const scheduleError = automationScheduleError(cronExpression, timezone);
  if (scheduleError) {
    log.triggers.error(
      { automationId, cronExpression, scheduleError },
      'Automation schedule is invalid',
    );
    return;
  }

  try {
    const task = cron.schedule(cronExpression, async (context) => {
      try {
        const fresh = await findAutomationDefinitionById(getDb(), automationId);
        if (!fresh?.enabled || fresh.trigger.type !== 'schedule') return;
        await dispatchStructuredAutomation(fresh, {
          kind: 'schedule',
          ...scheduleOccurrence(automationId, context),
        });
      } catch (error: unknown) {
        log.triggers.error({ err: error, automationId }, 'Scheduled automation failed');
      }
    }, { timezone, noOverlap: true });
    scheduledTasks.set(automationId, task);
    scheduledUpdatedAt.set(automationId, automation.updatedAt.getTime());
    log.triggers.info({ automationId, cronExpression, timezone }, 'Scheduled automation');
  } catch (error: unknown) {
    log.triggers.error({ err: error, automationId }, 'Could not schedule automation');
  }
}

async function reconcileScheduledAutomations(): Promise<void> {
  try {
    const rows = await listSchedulableAutomationVersions(getDb());
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      if (scheduledUpdatedAt.get(row.id) === row.updatedAt.getTime()) continue;
      const automation = await findAutomationDefinitionById(getDb(), row.id);
      if (automation) scheduleAutomation(automation);
    }
    for (const automationId of [...scheduledUpdatedAt.keys()]) {
      if (!seen.has(automationId)) unscheduleAutomation(automationId);
    }
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Automation schedule reconciliation failed');
  }
}

/**
 * The lease name stays stable across the rolling cutover so old and new tasks
 * cannot both lead while one deployment is draining.
 */
export function startTriggerEngine(options?: LeaderElectionOptions): LeaderElectionHandle {
  if (electionHandle) return electionHandle;
  electionHandle = startLeaderElection('trigger-engine', {
    onElected: () => startTriggerScheduler(),
    onDemoted: () => stopAllScheduledTasks(),
  }, options);
  return electionHandle;
}

export async function stopTriggerEngine(): Promise<void> {
  if (!electionHandle) return;
  const handle = electionHandle;
  electionHandle = null;
  await handle.stop();
}

export function isTriggerLeader(): boolean {
  return electionHandle?.isLeader() ?? false;
}

export async function startTriggerScheduler(): Promise<void> {
  log.triggers.info('Starting automation scheduler');
  try {
    const automations = await listSchedulableAutomationDefinitions(getDb());
    log.triggers.info({ automationCount: automations.length }, 'Found enabled automation schedules');
    for (const automation of automations) scheduleAutomation(automation);
    if (!reconcileTimer) {
      reconcileTimer = setInterval(
        () => { void reconcileScheduledAutomations(); },
        RECONCILE_INTERVAL_MS,
      );
      reconcileTimer.unref?.();
    }
    log.triggers.info('Automation scheduler started');
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Failed to start automation scheduler');
  }
}

export function stopAllScheduledTasks(): void {
  for (const [automationId, task] of scheduledTasks) {
    Promise.resolve(task.stop()).catch((error: unknown) => {
      log.triggers.error({ err: error, automationId }, 'Failed to stop scheduled automation');
    });
  }
  scheduledTasks.clear();
  scheduledUpdatedAt.clear();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  log.triggers.info('Stopped all scheduled automations');
}

export async function reloadAutomationSchedule(automationId: string): Promise<void> {
  if (!isTriggerLeader()) return;
  const automation = await findAutomationDefinitionById(getDb(), automationId);
  if (automation?.enabled && automation.trigger.type === 'schedule') {
    scheduleAutomation(automation);
    return;
  }
  unscheduleAutomation(automationId);
}
