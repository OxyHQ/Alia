/**
 * Automation Scheduler
 *
 * Uses node-cron to schedule and run automations based on their configured schedules.
 * Loads all enabled automations on startup and schedules them accordingly.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { generateText } from 'ai';
import { Automation, type IAutomation } from '../models/automation.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from './chat-core.js';

// Map of automation ID to scheduled task
const scheduledTasks = new Map<string, ScheduledTask>();

/**
 * Convert day name to cron day number (0 = Sunday, 1 = Monday, ... 6 = Saturday)
 */
function dayToCronNumber(day: string): number {
  const dayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return dayMap[day.toLowerCase()] ?? -1;
}

/**
 * Convert an automation schedule to a cron expression.
 *
 * Daily: "minute hour * * days"
 *   e.g., Monday-Friday at 18:00 -> "0 18 * * 1,2,3,4,5"
 *
 * Interval: "star/intervalMinutes * * * *" (runs every N minutes)
 */
function scheduleToCron(schedule: IAutomation['schedule']): string | null {
  if (schedule.type === 'interval' && schedule.intervalMinutes) {
    return `*/${schedule.intervalMinutes} * * * *`;
  }

  if (schedule.type === 'daily') {
    // Parse time (e.g., "18:00" or "06:00")
    const time = schedule.time || '09:00';
    const [hours, minutes] = time.split(':').map(Number);

    if (isNaN(hours) || isNaN(minutes)) {
      console.error(`[Scheduler] Invalid time format: ${time}`);
      return null;
    }

    // Convert days to cron day numbers
    const days = schedule.days || [];
    if (days.length === 0 || days.length === 7) {
      // Every day
      return `${minutes} ${hours} * * *`;
    }

    const cronDays = days
      .map(dayToCronNumber)
      .filter((d) => d >= 0)
      .sort()
      .join(',');

    if (!cronDays) {
      return `${minutes} ${hours} * * *`;
    }

    return `${minutes} ${hours} * * ${cronDays}`;
  }

  return null;
}

/**
 * Execute an automation: run its prompt through the AI and save the result.
 */
async function executeAutomation(automation: IAutomation): Promise<void> {
  const automationId = automation._id.toString();
  console.log(`[Scheduler] Running automation "${automation.name}" (${automationId})`);

  try {
    // Atomically mark as running, skip if already running (prevents concurrent execution)
    const updated = await Automation.findOneAndUpdate(
      { _id: automationId, lastRunStatus: { $ne: 'running' } },
      { $set: { lastRunStatus: 'running' } },
      { new: true }
    );
    if (!updated) {
      console.log(`[Scheduler] Automation "${automation.name}" is already running, skipping`);
      return;
    }

    // Resolve AI model
    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      automation.lastRunStatus = 'failed';
      automation.lastRunResult = 'No AI models available';
      await automation.save();
      console.error(`[Scheduler] No AI models available for automation ${automationId}`);
      return;
    }

    const model = getAIModel(resolved.keyConfig);

    // Run the prompt
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are Alia, an AI assistant running an automated task. Be concise and actionable in your response.',
        },
        {
          role: 'user',
          content: automation.prompt,
        },
      ],
      temperature: 0.3,
      maxRetries: 0,
    });

    const resultText = result.text || 'No response generated';

    // Update automation with result
    automation.lastRunAt = new Date();
    automation.runCount += 1;
    automation.lastRunResult = resultText;
    automation.lastRunStatus = 'success';
    await automation.save();

    console.log(`[Scheduler] Automation "${automation.name}" completed successfully`);
  } catch (error: any) {
    console.error(`[Scheduler] Automation "${automation.name}" failed:`, error.message);

    automation.lastRunStatus = 'failed';
    automation.lastRunResult = error.message || 'Execution failed';
    await automation.save();
  }
}

/**
 * Schedule a single automation using node-cron.
 */
function scheduleAutomation(automation: IAutomation): void {
  const automationId = automation._id.toString();

  // Remove existing schedule if any
  const existing = scheduledTasks.get(automationId);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(automationId);
  }

  if (!automation.enabled) {
    return;
  }

  const cronExpression = scheduleToCron(automation.schedule);
  if (!cronExpression) {
    console.error(`[Scheduler] Invalid schedule for automation "${automation.name}" (${automationId})`);
    return;
  }

  if (!cron.validate(cronExpression)) {
    console.error(`[Scheduler] Invalid cron expression "${cronExpression}" for automation "${automation.name}"`);
    return;
  }

  const task = cron.schedule(cronExpression, async () => {
    // Re-fetch the automation to get latest state (it may have been disabled)
    const fresh = await Automation.findById(automationId);
    if (!fresh || !fresh.enabled) {
      return;
    }
    await executeAutomation(fresh);
  });

  scheduledTasks.set(automationId, task);
  console.log(`[Scheduler] Scheduled "${automation.name}" with cron: ${cronExpression}`);
}

/**
 * Start the automation scheduler.
 * Loads all enabled automations and schedules them.
 * Should be called once after server starts.
 */
export async function startScheduler(): Promise<void> {
  console.log('[Scheduler] Starting automation scheduler...');

  try {
    const automations = await Automation.find({ enabled: true });
    console.log(`[Scheduler] Found ${automations.length} enabled automations`);

    for (const automation of automations) {
      scheduleAutomation(automation);
    }

    console.log('[Scheduler] Automation scheduler started');
  } catch (error) {
    console.error('[Scheduler] Failed to start scheduler:', error);
  }
}

/**
 * Reload a single automation's schedule (called when automation is created/updated/deleted).
 */
export async function reloadAutomation(automationId: string): Promise<void> {
  const automation = await Automation.findById(automationId);
  if (automation) {
    scheduleAutomation(automation);
  } else {
    // Automation was deleted — stop its schedule
    const existing = scheduledTasks.get(automationId);
    if (existing) {
      existing.stop();
      scheduledTasks.delete(automationId);
    }
  }
}
