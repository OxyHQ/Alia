/**
 * Trigger Management Tools
 *
 * Allow users to create, list, update, and delete triggers/routines conversationally.
 * Example: "Every morning at 8am, check my GitHub PRs and send me a summary on Telegram"
 */

import { tool } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Trigger } from '../../models/trigger.js';
import { TriggerExecution } from '../../models/trigger-execution.js';
import { reloadTrigger } from '../trigger-engine.js';
import { generateWebhookToken } from '../trigger-engine.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

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
        const triggerData: any = {
          oxyUserId: new mongoose.Types.ObjectId(userId),
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

        const trigger = await Trigger.create(triggerData);

        // Start cron schedule if applicable
        await reloadTrigger(trigger._id.toString());

        const summary: any = {
          success: true,
          triggerId: trigger._id.toString(),
          name: trigger.name,
          type: trigger.type,
          enabled: true,
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
        const filter: any = { oxyUserId: new mongoose.Types.ObjectId(userId) };
        if (args.type) filter.type = args.type;
        if (!args.includeDisabled) filter.enabled = true;

        const triggers = await Trigger.find(filter)
          .sort({ createdAt: -1 })
          .limit(20)
          .lean();

        return {
          success: true,
          count: triggers.length,
          triggers: triggers.map((t) => ({
            id: t._id.toString(),
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
        const trigger = await Trigger.findOne({
          _id: args.triggerId,
          oxyUserId: new mongoose.Types.ObjectId(userId),
        });

        if (!trigger) {
          return { success: false, error: 'Trigger not found' };
        }

        if (args.name) trigger.name = args.name;
        if (args.enabled !== undefined) trigger.enabled = args.enabled;
        if (args.prompt) trigger.action.prompt = args.prompt;
        if (args.notify !== undefined) trigger.action.notify = args.notify;
        if (args.channelId !== undefined) trigger.action.channelId = args.channelId;

        if (trigger.schedule) {
          if (args.time) trigger.schedule.time = args.time;
          if (args.days) trigger.schedule.days = args.days;
          if (args.intervalMinutes) trigger.schedule.intervalMinutes = args.intervalMinutes;
          if (args.timezone) trigger.schedule.timezone = args.timezone;
        }

        await trigger.save();
        await reloadTrigger(trigger._id.toString());

        return {
          success: true,
          triggerId: trigger._id.toString(),
          name: trigger.name,
          enabled: trigger.enabled,
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
        const result = await Trigger.findOneAndDelete({
          _id: triggerId,
          oxyUserId: new mongoose.Types.ObjectId(userId),
        });

        if (!result) {
          return { success: false, error: 'Trigger not found' };
        }

        // Stop the cron schedule
        await reloadTrigger(triggerId);

        return {
          success: true,
          message: `Trigger "${result.name}" deleted`,
        };
      } catch (error: unknown) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}
