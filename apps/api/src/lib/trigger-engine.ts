/**
 * Trigger Engine
 *
 * Unified execution engine for all trigger types (schedule, webhook, integration_event).
 * Handles scheduling via node-cron, webhook ingestion, and integration event processing.
 * Each trigger execution gets full AI capabilities including tools.
 */

import crypto from 'crypto';
import cron, { type ScheduledTask } from 'node-cron';
import { generateText, stepCountIs, type ToolSet } from 'ai';
import { Trigger, type ITrigger, type ITriggerSchedule } from '../models/trigger.js';
import { TriggerExecution } from '../models/trigger-execution.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from './chat-core.js';
import {
  getCurrentDateTool,
  webSearchTool,
  browseTool,
  saveUserMemoryTool,
  updateUserPreferencesTool,
  updateUserContextTool,
  createSendTelegramTool,
  webScraperTool,
} from './tools/index.js';
import { buildIntegrationTools } from './tools/integrations.js';
import { buildMcpTools } from './tools/mcp.js';
import { UserMemory, type IUserMemory } from '../models/user-memory.js';
import { oxyClient } from '../middleware/auth.js';
import { log } from './logger.js';
import type { User as OxyUser } from '@oxyhq/core';

// ── Scheduled task registry ────────────────────────────────────────

const scheduledTasks = new Map<string, ScheduledTask>();

// ── Cron helpers ───────────────────────────────────────────────────

function dayToCronNumber(day: string): number {
  const dayMap: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  return dayMap[day.toLowerCase()] ?? -1;
}

function scheduleToCron(schedule: ITriggerSchedule): string | null {
  if (schedule.type === 'cron' && schedule.cron) {
    return schedule.cron;
  }

  if (schedule.type === 'interval' && schedule.intervalMinutes) {
    return `*/${schedule.intervalMinutes} * * * *`;
  }

  if (schedule.type === 'daily') {
    const time = schedule.time || '09:00';
    const [hours, minutes] = time.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return null;

    const days = schedule.days || [];
    if (days.length === 0 || days.length === 7) {
      return `${minutes} ${hours} * * *`;
    }

    const cronDays = days
      .map(dayToCronNumber)
      .filter((d) => d >= 0)
      .sort()
      .join(',');

    return cronDays ? `${minutes} ${hours} * * ${cronDays}` : `${minutes} ${hours} * * *`;
  }

  return null;
}

// ── Tool builder ───────────────────────────────────────────────────

async function buildTriggerTools(userId: string, useTools: boolean): Promise<ToolSet> {
  // Always include basic tools
  const tools: ToolSet = {
    getCurrentDate: getCurrentDateTool,
  };

  if (!useTools) return tools;

  // Full tool set for triggers that opt in
  Object.assign(tools, {
    webSearch: webSearchTool,
    browse: browseTool,
    webScraper: webScraperTool,
    saveUserMemory: saveUserMemoryTool(userId),
    updateUserPreferences: updateUserPreferencesTool(userId),
    updateUserContext: updateUserContextTool(userId),
    sendTelegramMessage: createSendTelegramTool(userId),
  });

  // Add integration tools (GitHub, Notion, etc.)
  try {
    const integrationTools = await buildIntegrationTools(userId);
    Object.assign(tools, integrationTools);
  } catch (error) {
    log.triggers.error({ err: error, userId }, 'Failed to load integration tools for trigger');
  }

  // Add MCP tools
  try {
    const mcpTools = await buildMcpTools(userId);
    Object.assign(tools, mcpTools);
  } catch (error) {
    log.triggers.error({ err: error, userId }, 'Failed to load MCP tools for trigger');
  }

  return tools;
}

// ── System prompt builder ──────────────────────────────────────────

function buildTriggerSystemPrompt(
  trigger: ITrigger,
  oxyUser?: OxyUser | null,
  memory?: IUserMemory | null,
  source?: string
): string {
  const userContext: string[] = [];

  if (oxyUser) {
    const fullName = oxyUser.name?.full || [oxyUser.name?.first, oxyUser.name?.middle, oxyUser.name?.last].filter(Boolean).join(' ');
    if (fullName && fullName !== 'User') userContext.push(`The user's name is ${fullName}.`);
    if (oxyUser.username) userContext.push(`Username: @${oxyUser.username}.`);
    if (oxyUser.location) userContext.push(`Location: ${oxyUser.location}.`);
  }

  if (memory) {
    if (memory.preferences?.language) userContext.push(`Preferred language: ${memory.preferences.language}.`);
    if (memory.context?.occupation) userContext.push(`Occupation: ${memory.context.occupation}.`);
    if (memory.memories?.length) {
      const items = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
      userContext.push(`\nThings to remember:\n${items}`);
    }
  }

  let prompt = `You are Alia, an autonomous AI assistant processing a triggered task.

## Trigger: "${trigger.name}"
- Type: ${trigger.type}${source ? `\n- Source: ${source}` : ''}
- Run count: ${trigger.triggerCount + 1}${trigger.lastTriggeredAt ? `\n- Last run: ${trigger.lastTriggeredAt.toISOString()}` : ''}

## Guidelines
- Be concise and actionable. Lead with the result.
- Use the user's preferred language if known.
- Use available tools when they help accomplish the task.
- Respond with a brief summary of what you did.`;

  if (userContext.length > 0) {
    prompt = `# USER CONTEXT\n\n${userContext.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}

// ── Core execution ─────────────────────────────────────────────────

export interface TriggerExecutionContext {
  source: string;
  event?: string;
  payload?: Record<string, any>;
}

export async function executeTrigger(
  trigger: ITrigger,
  context: TriggerExecutionContext
): Promise<{ success: boolean; result?: string; executionId?: string }> {
  const triggerId = trigger._id.toString();
  const userId = trigger.oxyUserId.toString();
  const startTime = Date.now();

  log.triggers.info({ name: trigger.name, triggerId, source: context.source }, 'Executing trigger');

  // Create execution record
  const execution = await TriggerExecution.create({
    triggerId: trigger._id,
    oxyUserId: trigger.oxyUserId,
    status: 'running',
    triggerType: context.source === 'manual' ? 'manual' : trigger.type,
    input: {
      event: context.event,
      payload: context.payload,
      source: context.source,
    },
    startedAt: new Date(),
  });

  // Atomically mark trigger as running
  const updated = await Trigger.findOneAndUpdate(
    { _id: triggerId, lastStatus: { $ne: 'running' } },
    { $set: { lastStatus: 'running' } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    log.triggers.info({ name: trigger.name }, 'Trigger already running, skipping');
    execution.status = 'failed';
    execution.result = 'Trigger already running';
    execution.completedAt = new Date();
    execution.durationMs = Date.now() - startTime;
    await execution.save();
    return { success: false, result: 'Trigger already running', executionId: execution._id.toString() };
  }

  try {
    // Load user context
    const [memory, oxyUser] = await Promise.all([
      UserMemory.findOne({ oxyUserId: userId }).catch(() => null),
      oxyClient.getUserById(userId).catch(() => null) as Promise<OxyUser | null>,
    ]);

    // Resolve AI model
    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      throw new Error('No AI models available');
    }

    const model = getAIModel(resolved.keyConfig);
    const tools = await buildTriggerTools(userId, trigger.action.useTools);
    const systemPrompt = buildTriggerSystemPrompt(trigger, oxyUser, memory, context.source);

    // Build user message
    let userMessage = trigger.action.prompt;
    if (context.payload) {
      userMessage += `\n\n---\nTrigger payload:\n${JSON.stringify(context.payload, null, 2)}`;
    }
    if (context.event) {
      userMessage += `\n\nEvent: ${context.event}`;
    }

    // Execute AI
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      tools,
      temperature: 0.3,
      maxRetries: 0,
      stopWhen: stepCountIs(8),
    } as any);

    const durationMs = Date.now() - startTime;
    const resultText = result.text || 'No response generated';

    // Extract tool calls
    const toolCalls = result.steps?.flatMap((step: any) =>
      (step.toolCalls || []).map((tc: any) => ({
        tool: tc.toolName,
        args: tc.args,
      }))
    ) || [];

    // Extract token usage
    const tokens = result.usage ? {
      prompt: (result.usage as any).inputTokens || 0,
      completion: (result.usage as any).outputTokens || 0,
      total: result.usage.totalTokens || 0,
    } : undefined;

    // Update execution record
    execution.status = 'success';
    execution.result = resultText;
    execution.toolCalls = toolCalls;
    execution.tokens = tokens;
    execution.durationMs = durationMs;
    execution.completedAt = new Date();
    await execution.save();

    // Update trigger stats
    await Trigger.findByIdAndUpdate(triggerId, {
      $set: {
        lastTriggeredAt: new Date(),
        lastStatus: 'success',
        lastResult: resultText.slice(0, 2000),
      },
      $inc: { triggerCount: 1 },
    });

    log.triggers.info({ name: trigger.name, triggerId, durationMs, toolCalls: toolCalls.length }, 'Trigger completed');

    return { success: true, result: resultText, executionId: execution._id.toString() };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    log.triggers.error({ err: error, name: trigger.name, triggerId }, 'Trigger execution failed');

    execution.status = 'failed';
    execution.result = error.message || 'Execution failed';
    execution.durationMs = durationMs;
    execution.completedAt = new Date();
    await execution.save();

    await Trigger.findByIdAndUpdate(triggerId, {
      $set: {
        lastStatus: 'failed',
        lastResult: error.message || 'Execution failed',
        lastTriggeredAt: new Date(),
      },
    });

    return { success: false, result: error.message, executionId: execution._id.toString() };
  }
}

// ── Schedule management ────────────────────────────────────────────

function scheduleTrigger(trigger: ITrigger): void {
  const triggerId = trigger._id.toString();

  // Remove existing schedule
  const existing = scheduledTasks.get(triggerId);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(triggerId);
  }

  if (!trigger.enabled || trigger.type !== 'schedule' || !trigger.schedule) return;

  const cronExpression = scheduleToCron(trigger.schedule);
  if (!cronExpression) {
    log.triggers.error({ name: trigger.name, triggerId }, 'Invalid schedule configuration');
    return;
  }

  if (!cron.validate(cronExpression)) {
    log.triggers.error({ cronExpression, name: trigger.name }, 'Invalid cron expression');
    return;
  }

  const task = cron.schedule(cronExpression, async () => {
    try {
      const fresh = await Trigger.findById(triggerId);
      if (!fresh || !fresh.enabled) return;
      await executeTrigger(fresh, { source: 'cron' });
    } catch (error) {
      log.triggers.error({ err: error, triggerId }, 'Scheduled trigger cron task failed');
    }
  }, {
    timezone: trigger.schedule.timezone,
  });

  scheduledTasks.set(triggerId, task);
  log.triggers.info({ name: trigger.name, cronExpression, timezone: trigger.schedule.timezone }, 'Scheduled trigger');
}

// ── Webhook verification ───────────────────────────────────────────

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

// ── Integration event matching ─────────────────────────────────────

export async function findTriggersForIntegrationEvent(
  service: string,
  event: string,
  userId: string,
  eventData?: Record<string, any>
): Promise<ITrigger[]> {
  const triggers = await Trigger.find({
    oxyUserId: userId,
    type: 'integration_event',
    enabled: true,
    'integrationEvent.service': service,
    'integrationEvent.event': event,
  });

  // Apply filters
  return triggers.filter((trigger) => {
    const filters = trigger.integrationEvent?.filters;
    if (!filters || Object.keys(filters).length === 0) return true;
    if (!eventData) return true;

    // Simple key-value filter matching
    return Object.entries(filters).every(([key, value]) => {
      const actual = eventData[key];
      if (typeof value === 'string' && typeof actual === 'string') {
        return actual.toLowerCase().includes(value.toLowerCase());
      }
      return actual === value;
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Start the trigger scheduler. Loads all enabled schedule triggers and sets up cron jobs.
 */
export async function startTriggerScheduler(): Promise<void> {
  log.triggers.info('Starting trigger scheduler...');

  try {
    const triggers = await Trigger.find({ type: 'schedule', enabled: true });
    log.triggers.info({ count: triggers.length }, 'Found enabled schedule triggers');

    for (const trigger of triggers) {
      scheduleTrigger(trigger);
    }

    log.triggers.info('Trigger scheduler started');
  } catch (error) {
    log.triggers.error({ err: error }, 'Failed to start trigger scheduler');
  }
}

/**
 * Reload a single trigger's schedule (called on create/update/delete).
 */
export async function reloadTrigger(triggerId: string): Promise<void> {
  const trigger = await Trigger.findById(triggerId);
  if (trigger && trigger.type === 'schedule') {
    scheduleTrigger(trigger);
  } else {
    // Trigger deleted or type changed — stop its schedule
    const existing = scheduledTasks.get(triggerId);
    if (existing) {
      existing.stop();
      scheduledTasks.delete(triggerId);
    }
  }
}

/**
 * Process an incoming webhook request for a trigger.
 */
export async function processWebhookTrigger(
  token: string,
  payload: Record<string, any>,
  headers?: Record<string, string>
): Promise<{ success: boolean; result?: string; triggerId?: string; executionId?: string }> {
  const trigger = await Trigger.findOne({
    'webhook.token': token,
    type: 'webhook',
    enabled: true,
  });

  if (!trigger) {
    return { success: false, result: 'Trigger not found or disabled' };
  }

  // Verify HMAC signature if secret is configured
  if (trigger.webhook?.secret && headers) {
    const signature = headers['x-trigger-signature'] || headers['x-webhook-signature'];
    if (!signature) {
      return { success: false, result: 'Missing webhook signature' };
    }
    const payloadStr = JSON.stringify(payload);
    if (!verifyWebhookSignature(payloadStr, signature, trigger.webhook.secret)) {
      return { success: false, result: 'Invalid webhook signature' };
    }
  }

  // Check IP allowlist
  if (trigger.webhook?.allowedIps?.length && headers) {
    const clientIp = headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'];
    if (clientIp && !trigger.webhook.allowedIps.includes(clientIp)) {
      return { success: false, result: 'IP not allowed' };
    }
  }

  const { success, result, executionId } = await executeTrigger(trigger, {
    source: 'webhook',
    payload,
  });

  return { success, result, triggerId: trigger._id.toString(), executionId };
}

/**
 * Migrate existing Automation documents to Trigger documents.
 * Safe to run multiple times — skips automations that already have a matching trigger.
 */
export async function migrateAutomationsToTriggers(): Promise<{ migrated: number; skipped: number }> {
  const { Automation } = await import('../models/automation.js');

  const automations = await Automation.find({});
  let migrated = 0;
  let skipped = 0;

  for (const automation of automations) {
    // Check if already migrated (match by name + user)
    const existing = await Trigger.findOne({
      oxyUserId: automation.oxyUserId,
      name: automation.name,
      type: 'schedule',
    });

    if (existing) {
      skipped++;
      continue;
    }

    await Trigger.create({
      oxyUserId: automation.oxyUserId,
      name: automation.name,
      description: `Migrated from automation`,
      type: 'schedule',
      enabled: automation.enabled,
      action: {
        prompt: automation.prompt,
        roleId: automation.roleId,
        useTools: false,
        notify: false,
      },
      schedule: {
        type: automation.schedule.type,
        time: automation.schedule.time,
        days: automation.schedule.days,
        intervalMinutes: automation.schedule.intervalMinutes,
      },
      lastTriggeredAt: automation.lastRunAt,
      triggerCount: automation.runCount,
      lastStatus: automation.lastRunStatus as any,
      lastResult: automation.lastRunResult,
    });

    migrated++;
  }

  log.triggers.info({ migrated, skipped }, 'Automation migration complete');
  return { migrated, skipped };
}

/**
 * Process integration events by finding matching triggers and executing them.
 */
export async function processIntegrationEvent(
  service: string,
  event: string,
  userId: string,
  eventData?: Record<string, any>
): Promise<void> {
  const triggers = await findTriggersForIntegrationEvent(service, event, userId, eventData);

  if (triggers.length === 0) return;

  log.triggers.info({ service, event, userId, count: triggers.length }, 'Processing integration event triggers');

  // Execute all matching triggers in parallel
  await Promise.allSettled(
    triggers.map((trigger) =>
      executeTrigger(trigger, {
        source: service,
        event: `${service}.${event}`,
        payload: eventData,
      })
    )
  );
}
