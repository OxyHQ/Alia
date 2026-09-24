/** Elected cron scheduler for normalized automation definitions. */

import cron, { type ScheduledTask, type TaskContext } from 'node-cron';
import cronParser from 'cron-parser';
import {
  automationRunExists,
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

/**
 * How far back a missed occurrence is still run.
 *
 * `node-cron` fires only while this process leads and is up. A deploy replaces
 * every task, and leadership takes up to its lease to move, so an occurrence
 * that fell in that gap never fired — and a one-off task (`runOnce`) that never
 * fires is never disabled, so its five-field cron comes round again next year.
 * Each reconcile runs the latest occurrence inside this window that has no run
 * yet; the run is keyed by the same occurrence id the live cron uses, so the
 * two cannot both run it.
 */
const CATCH_UP_WINDOW_MS = 30 * 60 * 1000;
/**
 * Occurrences this leader already dispatched or tried to. A denied dispatch
 * (no eligible agent, no credits) creates no run, so without this the catch-up
 * would retry it — and notify the person — every reconcile.
 */
const attemptedOccurrences = new Set<string>();
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
  return occurrenceAt(automationId, new Date(context.date));
}

function occurrenceAt(automationId: string, date: Date) {
  const occurredAt = new Date(date);
  occurredAt.setMilliseconds(0);
  return {
    occurredAt,
    id: `schedule:${automationId}:${occurredAt.toISOString()}`,
  };
}

/**
 * The latest occurrence of this schedule inside the catch-up window, if any,
 * that falls after the definition last changed (an edit is not a missed run).
 */
export function missedOccurrence(
  automation: Pick<AutomationDefinitionRecord, 'id' | 'enabled' | 'trigger' | 'updatedAt'>,
  now: Date = new Date(),
): { occurredAt: Date; id: string } | null {
  if (!automation.enabled || automation.trigger.type !== 'schedule') return null;
  const { cron: expression, timezone } = automation.trigger;
  if (!expression || !timezone || automationScheduleError(expression, timezone)) return null;
  try {
    const previous = cronParser.parseExpression(expression, { currentDate: now, tz: timezone }).prev().toDate();
    const since = Math.max(now.getTime() - CATCH_UP_WINDOW_MS, automation.updatedAt.getTime());
    if (previous.getTime() <= since) return null;
    return occurrenceAt(automation.id, previous);
  } catch {
    return null;
  }
}

async function catchUpMissedOccurrences(now: Date = new Date()): Promise<void> {
  // An occurrence older than the window can never be caught up again.
  for (const id of attemptedOccurrences) {
    // `schedule:<automation uuid>:<ISO instant>` — the instant is everything
    // after the second colon.
    const at = Date.parse(id.split(':').slice(2).join(':'));
    if (!Number.isNaN(at) && at < now.getTime() - 2 * CATCH_UP_WINDOW_MS) attemptedOccurrences.delete(id);
  }
  const automations = await listSchedulableAutomationDefinitions(getDb());
  for (const automation of automations) {
    const occurrence = missedOccurrence(automation, now);
    if (!occurrence || attemptedOccurrences.has(occurrence.id)) continue;
    attemptedOccurrences.add(occurrence.id);
    try {
      // Checked first so a run the live cron already made costs one read here,
      // not a credit hold and its refund.
      if (await automationRunExists(getDb(), automation.id, occurrence.id)) continue;
      // Idempotent by occurrence id: a run the live cron already claimed is a
      // `duplicate` here, and nothing else happens.
      const result = await dispatchStructuredAutomation(automation, { kind: 'schedule', ...occurrence });
      if (result.status === 'queued') {
        log.triggers.warn({ automationId: automation.id, occurrence: occurrence.id }, 'Ran a missed scheduled occurrence');
      }
    } catch (error: unknown) {
      log.triggers.error({ err: error, automationId: automation.id }, 'Could not catch up a missed occurrence');
    }
  }
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
        const occurrence = scheduleOccurrence(automationId, context);
        attemptedOccurrences.add(occurrence.id);
        await dispatchStructuredAutomation(fresh, { kind: 'schedule', ...occurrence });
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
    await catchUpMissedOccurrences();
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
    // A new leader first runs what fell in the gap before it took over.
    await catchUpMissedOccurrences();
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
  attemptedOccurrences.clear();
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
