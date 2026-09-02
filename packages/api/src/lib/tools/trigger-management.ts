/**
 * Trigger Management Tools
 *
 * Allow users to create, list, update, and delete triggers/routines conversationally.
 * Example: "Every morning at 8am, check my GitHub PRs and send me a summary on Telegram"
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {
  createTrigger,
  deleteTriggerForUser,
  findTriggerForUser,
  listTriggers,
  updateTrigger,
  type NewTrigger,
} from '../../db/automation/triggerRepository.js';
import { disableLegacyTriggerAutomation } from '../../db/automation/automationDefinitionRepository.js';
import { reloadTrigger } from '../trigger-engine.js';
import { generateWebhookToken } from '../trigger-engine.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { automationReceipt, syncStructuredAutomation } from '../structured-automation.js';

export function createTriggerTool(userId: string) {
  return tool({
    description: 'Create an automated trigger/routine that runs on a schedule, webhook, or integration event. Use when the user wants recurring tasks, reminders, monitoring, or automations.',
    inputSchema: z.object({
      name: z.string().describe('Short name for the trigger (e.g., "Morning GitHub Summary")'),
      description: z.string().optional().describe('Description of what this trigger does'),
      prompt: z.string().describe('Instructions for what the AI should do when triggered'),
      type: z.enum(['schedule', 'webhook']).default('schedule').describe('Trigger type'),
      scheduleType: z.enum(['daily', 'interval', 'cron']).optional().describe('Schedule type (for schedule triggers)'),
      time: z.string().optional().describe('Time in HH:MM format (for daily schedules)'),
      days: z.array(z.string()).optional().describe('Days of week (monday, tuesday, etc.) — omit for every day'),
      intervalMinutes: z.number().optional().describe('Interval in minutes (for interval schedules)'),
      cron: z.string().optional().describe('Raw cron expression (for advanced users)'),
      timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
      useTools: z.boolean().default(true).describe('Whether the AI can use tools (web search, integrations, etc.)'),
      notify: z.boolean().default(true).describe('Whether to send a notification with the result'),
      channelId: z.string().optional().describe('Channel to notify on (telegram, discord, whatsapp, slack)'),
    }),
    execute: async (args) => {
      try {
        const triggerData: NewTrigger = {
          oxyUserId: userId,
          name: args.name,
          description: args.description,
          type: args.type,
          enabled: true,
          action: {
            prompt: args.prompt,
            useTools: args.useTools,
            notify: args.notify,
            channelId: args.channelId,
          },
        };

        if (args.type === 'schedule') {
          triggerData.schedule = {
            type: args.scheduleType || 'daily',
            time: args.time,
            days: args.days,
            intervalMinutes: args.intervalMinutes,
            cron: args.cron,
            timezone: args.timezone,
          };
        } else if (args.type === 'webhook') {
          triggerData.webhook = {
            token: generateWebhookToken(),
          };
        }

        const trigger = await createTrigger(getDb(), triggerData);
        const automation = await syncStructuredAutomation(trigger);

        // Start cron schedule if applicable
        await reloadTrigger(trigger._id);

        const summary: Record<string, unknown> = {
          success: true,
          triggerId: trigger._id.toString(),
          name: trigger.name,
          type: trigger.type,
          enabled: true,
          automation,
          receipt: automationReceipt(automation),
        };

        if (trigger.type === 'schedule' && trigger.schedule) {
          summary.schedule = {
            type: trigger.schedule.type,
            time: trigger.schedule.time,
            days: trigger.schedule.days,
            intervalMinutes: trigger.schedule.intervalMinutes,
            timezone: trigger.schedule.timezone,
          };
        }

        if (trigger.type === 'webhook' && trigger.webhook) {
          summary.webhookUrl = `/triggers/webhook/${trigger.webhook.token}`;
        }

        return summary;
      } catch (error: unknown) {
        log.triggers.error({ err: error }, 'Failed to create trigger via tool');
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}

export function listTriggersTool(userId: string) {
  return tool({
    description: 'List the user\'s active triggers/routines/automations. Use to show what automations are currently set up.',
    inputSchema: z.object({
      type: z.enum(['schedule', 'webhook', 'integration_event']).optional().describe('Filter by trigger type'),
      includeDisabled: z.boolean().default(false).describe('Whether to include disabled triggers'),
    }),
    execute: async (args) => {
      try {
        const triggers = await listTriggers(getDb(), userId, {
          type: args.type,
          enabledOnly: !args.includeDisabled,
          limit: 20,
        });

        return {
          success: true,
          count: triggers.length,
          triggers: triggers.map((t) => ({
            id: t._id,
            name: t.name,
            description: t.description,
            type: t.type,
            enabled: t.enabled,
            schedule: t.schedule,
            lastStatus: t.lastStatus,
            lastTriggeredAt: t.lastTriggeredAt,
            triggerCount: t.triggerCount,
          })),
        };
      } catch (error: unknown) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}

export function updateTriggerTool(userId: string) {
  return tool({
    description: 'Update an existing trigger/routine. Use to change schedule, prompt, enable/disable, or modify notification settings.',
    inputSchema: z.object({
      triggerId: z.string().describe('ID of the trigger to update'),
      name: z.string().optional().describe('New name'),
      prompt: z.string().optional().describe('New AI instructions'),
      enabled: z.boolean().optional().describe('Enable or disable the trigger'),
      time: z.string().optional().describe('New time in HH:MM format'),
      days: z.array(z.string()).optional().describe('New days of week'),
      intervalMinutes: z.number().optional().describe('New interval in minutes'),
      timezone: z.string().optional().describe('New timezone'),
      notify: z.boolean().optional().describe('Whether to send notifications'),
      channelId: z.string().optional().describe('Notification channel'),
    }),
    execute: async (args) => {
      try {
        const existing = await findTriggerForUser(getDb(), args.triggerId, userId);

        if (!existing) {
          return { success: false, error: 'Trigger not found' };
        }

        // This tool MERGES the schedule — it assigned individual fields on the
        // hydrated document — where the HTTP route replaces it wholesale. The
        // merge is done here, against the row just read, so the repository keeps
        // one replace-shaped `schedule` and the two callers keep their own
        // semantics. Only touched when a schedule already exists, as before.
        const schedule = existing.schedule && {
          ...existing.schedule,
          ...(args.time ? { time: args.time } : {}),
          ...(args.days ? { days: args.days } : {}),
          ...(args.intervalMinutes ? { intervalMinutes: args.intervalMinutes } : {}),
          ...(args.timezone ? { timezone: args.timezone } : {}),
        };

        const trigger = await updateTrigger(getDb(), existing._id, {
          ...(args.name ? { name: args.name } : {}),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
          action: {
            ...(args.prompt ? { prompt: args.prompt } : {}),
            ...(args.notify === undefined ? {} : { notify: args.notify }),
            ...(args.channelId === undefined ? {} : { channelId: args.channelId }),
          },
          ...(schedule ? { schedule } : {}),
        });
        if (!trigger) throw new Error('Trigger disappeared while it was being updated');
        const automation = await syncStructuredAutomation(trigger);

        await reloadTrigger(existing._id);

        return {
          success: true,
          triggerId: existing._id,
          name: trigger.name,
          enabled: trigger.enabled,
          automation,
          receipt: automationReceipt(automation),
        };
      } catch (error: unknown) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}

export function deleteTriggerTool(userId: string) {
  return tool({
    description: 'Delete a trigger/routine. Use when the user wants to remove an automation.',
    inputSchema: z.object({
      triggerId: z.string().describe('ID of the trigger to delete'),
    }),
    execute: async ({ triggerId }) => {
      try {
        const deleted = await deleteTriggerForUser(getDb(), triggerId, userId);

        if (!deleted) {
          return { success: false, error: 'Trigger not found' };
        }
        await disableLegacyTriggerAutomation(getDb(), triggerId);

        // Stop the cron schedule
        await reloadTrigger(triggerId);

        return {
          success: true,
          stopped: true,
          message: `Trigger "${deleted.name}" deleted`,
        };
      } catch (error: unknown) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}
