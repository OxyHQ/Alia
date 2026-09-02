/**
 * Trigger Management Tools
 *
 * Transitional maintenance tools for legacy triggers. New recurring work is
 * created only through the normalized createAutomation tool.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {
  deleteTriggerForUser,
  findTriggerForUser,
  listTriggers,
  updateTrigger,
} from '../../db/automation/triggerRepository.js';
import { disableLegacyTriggerAutomation } from '../../db/automation/automationDefinitionRepository.js';
import { reloadTrigger } from '../trigger-engine.js';
import { getErrorMessage } from '../errors/index.js';
import { automationReceipt, syncStructuredAutomation } from '../structured-automation.js';

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
