/**
 * Trigger Engine
 *
 * Unified execution engine for all trigger types (schedule, webhook, integration_event).
 * Handles scheduling via node-cron, webhook ingestion, and integration event processing.
 * Each trigger execution gets full AI capabilities including tools.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import cron, { type ScheduledTask } from 'node-cron';
import { generateText, stepCountIs, type ToolSet } from 'ai';
import { Trigger, type ITrigger, type ITriggerSchedule, type TriggerType } from '../models/trigger.js';
import { Agent, type IAgent } from '../models/agent.js';
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
import { getErrorMessage } from './errors/index.js';
import { sendNotification } from './notification-service.js';
import type { NotificationChannel } from '../models/notification.js';
import { buildArchetypeSystemPrompt } from './agent/archetype-prompts.js';
import { handleRoutingDecision } from './agent/routing-handler.js';
import { startLeaderElection, type LeaderElectionHandle, type LeaderElectionOptions } from './leader-election.js';
import type { User as OxyUser } from '@oxyhq/core';

// ── Scheduled task registry ────────────────────────────────────────

const scheduledTasks = new Map<string, ScheduledTask>();
// Tracks the updatedAt (epoch ms) of each currently scheduled trigger so the
// reconcile loop can detect edits made by (and cron tasks removed on) instances
// other than the leader — standalone Mongo has no change streams.
const scheduledUpdatedAt = new Map<string, number>();
const RECONCILE_INTERVAL_MS = 30_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let electionHandle: LeaderElectionHandle | null = null;
let legacyMigrationDone = false;

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
    // Load user context + linked agent (if any)
    const [memory, oxyUser, linkedAgent] = await Promise.all([
      UserMemory.findOne({ oxyUserId: userId }).catch(() => null),
      oxyClient.getUserById(userId).catch(() => null) as Promise<OxyUser | null>,
      trigger.action.agentId
        ? Agent.findById(trigger.action.agentId).select('name archetype archetypeConfig systemPrompt').lean().catch(() => null)
        : Promise.resolve(null),
    ]);

    // Resolve AI model
    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      throw new Error('No AI models available');
    }

    const model = getAIModel(resolved.keyConfig);
    const tools = await buildTriggerTools(userId, trigger.action.useTools);

    // Use archetype system prompt if the linked agent has one
    let systemPrompt: string;
    if (linkedAgent?.archetype && linkedAgent.archetype !== 'general') {
      const archetypePrompt = linkedAgent.systemPrompt || buildArchetypeSystemPrompt(linkedAgent as IAgent);
      systemPrompt = archetypePrompt || buildTriggerSystemPrompt(trigger, oxyUser, memory, context.source);
    } else {
      systemPrompt = buildTriggerSystemPrompt(trigger, oxyUser, memory, context.source);
    }

    // Build user message
    let userMessage = trigger.action.prompt;
    if (context.payload) {
      userMessage += `\n\n---\nTrigger payload:\n${JSON.stringify(context.payload, null, 2)}`;
    }
    if (context.event) {
      userMessage += `\n\nEvent: ${context.event}`;
    }

    // Previous report comparison for status_update agents
    if (linkedAgent?.archetype === 'status_update' && linkedAgent.archetypeConfig?.compareWithPrevious) {
      const previousExecution = await TriggerExecution.findOne({
        triggerId: trigger._id,
        status: 'success',
      }).sort({ completedAt: -1 }).select('result completedAt').lean();

      if (previousExecution?.result) {
        userMessage += `\n\n---\n## Previous Report (${previousExecution.completedAt?.toISOString() || 'unknown date'})\n\n${previousExecution.result.slice(0, 4000)}`;
      }
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
    });

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
      prompt: result.usage.inputTokens || 0,
      completion: result.usage.outputTokens || 0,
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

    // Task router: process routing decision
    if (linkedAgent?.archetype === 'task_router') {
      try {
        await handleRoutingDecision(linkedAgent as IAgent, resultText, trigger);
      } catch (routingErr) {
        log.triggers.error({ err: routingErr, triggerId }, 'Failed to process routing decision');
      }
    }

    // Deliver notification if enabled
    if (trigger.action.notify) {
      // Multi-channel delivery for status_update agents
      const deliveryChannels: NotificationChannel[] | undefined = linkedAgent?.archetype === 'status_update'
        && linkedAgent.archetypeConfig?.deliveryChannels?.length
        ? [...linkedAgent.archetypeConfig.deliveryChannels, 'in_app'] as NotificationChannel[]
        : trigger.action.channelId
          ? [trigger.action.channelId as NotificationChannel, 'in_app']
          : undefined;

      sendNotification({
        userId,
        type: 'trigger_result',
        title: trigger.name,
        body: resultText.slice(0, 4000),
        channels: deliveryChannels,
        triggerId,
        data: { executionId: execution._id.toString() },
      }).catch((err) => {
        log.triggers.error({ err, triggerId }, 'Failed to send trigger notification');
      });
    }

    return { success: true, result: resultText, executionId: execution._id.toString() };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errMsg = getErrorMessage(error);
    log.triggers.error({ err: error, name: trigger.name, triggerId }, 'Trigger execution failed');

    execution.status = 'failed';
    execution.result = errMsg;
    execution.durationMs = durationMs;
    execution.completedAt = new Date();
    await execution.save();

    await Trigger.findByIdAndUpdate(triggerId, {
      $set: {
        lastStatus: 'failed',
        lastResult: errMsg,
        lastTriggeredAt: new Date(),
      },
    });

    return { success: false, result: errMsg, executionId: execution._id.toString() };
  }
}

// ── Schedule management ────────────────────────────────────────────

function unscheduleTrigger(triggerId: string): void {
  const existing = scheduledTasks.get(triggerId);
  if (existing) {
    Promise.resolve(existing.stop()).catch((err) => log.triggers.error({ err, triggerId }, 'Failed to stop scheduled task'));
    scheduledTasks.delete(triggerId);
    scheduledUpdatedAt.delete(triggerId);
  }
}

function scheduleTrigger(trigger: ITrigger): void {
  const triggerId = trigger._id.toString();

  // Remove existing schedule before (re)scheduling in place
  unscheduleTrigger(triggerId);

  if (!trigger.enabled || (trigger.type !== 'schedule' && trigger.type !== 'agent_heartbeat') || !trigger.schedule) return;

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
  scheduledUpdatedAt.set(triggerId, trigger.updatedAt?.getTime() ?? 0);
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
 * Start the trigger engine under Mongo-lease leader election. The elected
 * instance runs the scheduler; every other instance stays idle so a scheduled
 * trigger fires exactly once across a cluster of ECS tasks. Idempotent.
 */
export function startTriggerEngine(opts?: LeaderElectionOptions): LeaderElectionHandle {
  if (electionHandle) return electionHandle;
  electionHandle = startLeaderElection(
    'trigger-engine',
    {
      onElected: () => startTriggerScheduler(),
      onDemoted: () => { stopAllScheduledTasks(); },
    },
    opts
  );
  return electionHandle;
}

/**
 * Stop the trigger engine: releases the leadership lease (demoting this instance,
 * which stops all scheduled tasks) and clears the election handle. For shutdown.
 */
export async function stopTriggerEngine(): Promise<void> {
  if (!electionHandle) return;
  const handle = electionHandle;
  electionHandle = null;
  await handle.stop();
}

/** Whether this instance currently holds the trigger-engine leadership lease. */
export function isTriggerLeader(): boolean {
  return electionHandle?.isLeader() ?? false;
}

/**
 * Start the trigger scheduler. Loads all enabled schedule triggers and sets up cron jobs.
 * Also starts the agent heartbeat scheduler and the reconcile loop. Runs on the leader.
 */
export async function startTriggerScheduler(): Promise<void> {
  log.triggers.info('Starting trigger scheduler...');

  try {
    await migrateLegacyAutomations();

    const triggers = await Trigger.find({
      type: { $in: ['schedule', 'agent_heartbeat'] },
      enabled: true,
    });
    log.triggers.info({ count: triggers.length }, 'Found enabled schedule triggers');

    for (const trigger of triggers) {
      scheduleTrigger(trigger);
    }

    // Start agent heartbeat scheduler
    await startAgentHeartbeatScheduler();

    // Reconcile loop: pick up trigger edits/deletes served by follower instances
    // (which no-op reloadTrigger) since standalone Mongo has no change streams.
    if (!reconcileTimer) {
      reconcileTimer = setInterval(() => { void reconcileScheduledTriggers(); }, RECONCILE_INTERVAL_MS);
      reconcileTimer.unref?.();
    }

    log.triggers.info('Trigger scheduler started');
  } catch (error) {
    log.triggers.error({ err: error }, 'Failed to start trigger scheduler');
  }
}

/**
 * Stop every scheduled cron task, clear the registry, and stop the reconcile
 * loop. Called when this instance is demoted from leadership or on shutdown.
 */
export function stopAllScheduledTasks(): void {
  for (const [triggerId, task] of scheduledTasks) {
    Promise.resolve(task.stop()).catch((err) => log.triggers.error({ err, triggerId }, 'Failed to stop scheduled task'));
  }
  scheduledTasks.clear();
  scheduledUpdatedAt.clear();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  log.triggers.info('Stopped all scheduled tasks');
}

/**
 * Diff the DB's enabled schedule/heartbeat triggers against the in-memory
 * registry: (re)schedule new or edited triggers, drop disappeared ones.
 */
async function reconcileScheduledTriggers(): Promise<void> {
  try {
    const rows = await Trigger.find({
      type: { $in: ['schedule', 'agent_heartbeat'] },
      enabled: true,
    }).select('_id updatedAt').lean();

    const seen = new Set<string>();
    for (const row of rows) {
      const triggerId = row._id.toString();
      seen.add(triggerId);
      const updatedAtMs = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
      if (scheduledUpdatedAt.get(triggerId) === updatedAtMs) continue;

      // New or changed since we last scheduled it — reschedule in place.
      const full = await Trigger.findById(triggerId);
      if (full) scheduleTrigger(full);
    }

    // Triggers that were scheduled but no longer match (deleted/disabled/retyped).
    for (const triggerId of [...scheduledUpdatedAt.keys()]) {
      if (!seen.has(triggerId)) unscheduleTrigger(triggerId);
    }
  } catch (error) {
    log.triggers.error({ err: error }, 'Trigger reconcile failed');
  }
}

async function migrateLegacyAutomations(): Promise<void> {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;

  const db = mongoose.connection.db;
  if (!db) return;

  const legacy = db.collection('automations');
  const count = await legacy.countDocuments().catch(() => 0);
  if (!count) return;

  const docs = await legacy.find({}).toArray();
  let migrated = 0;

  for (const doc of docs) {
    const oxyUserId = doc.oxyUserId;
    const name = String(doc.name || '').trim();
    const prompt = String(doc.prompt || '').trim();
    if (!oxyUserId || !name || !prompt) continue;

    const schedule: ITriggerSchedule = {
      type: doc.schedule?.type === 'interval' ? 'interval' : 'daily',
      ...(doc.schedule?.type === 'interval'
        ? { intervalMinutes: Math.max(1, Number(doc.schedule?.intervalMinutes || 60)) }
        : {
            time: typeof doc.schedule?.time === 'string' ? doc.schedule.time : '09:00',
            days: Array.isArray(doc.schedule?.days) ? doc.schedule.days : undefined,
          }),
    };

    const exists = await Trigger.findOne({
      oxyUserId,
      name,
      type: 'schedule',
      'action.prompt': prompt,
    }).select('_id').lean();
    if (exists) continue;

    await Trigger.create({
      oxyUserId,
      name,
      description: 'Migrated from legacy automations',
      type: 'schedule',
      enabled: doc.enabled !== false,
      action: {
        prompt,
        roleId: doc.roleId,
        useTools: true,
        notify: false,
      },
      schedule,
      lastTriggeredAt: doc.lastRunAt,
      triggerCount: Number(doc.runCount || 0),
      lastStatus: doc.lastRunStatus,
      lastResult: doc.lastRunResult,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }).catch(() => {});

    migrated++;
  }

  // Hard cut: remove legacy rows once migrated.
  await legacy.deleteMany({}).catch(() => {});

  log.triggers.info({ migrated, scanned: docs.length }, 'Legacy automations migrated to triggers');
}

/**
 * Reload a single trigger's schedule (called on create/update/delete).
 * No-op on follower instances — only the leader owns the cron registry; edits
 * served by followers are picked up by the leader's reconcile loop.
 */
export async function reloadTrigger(triggerId: string): Promise<void> {
  if (!isTriggerLeader()) return;

  const trigger = await Trigger.findById(triggerId);
  if (trigger && (trigger.type === 'schedule' || trigger.type === 'agent_heartbeat')) {
    scheduleTrigger(trigger);
  } else {
    // Trigger deleted, disabled, or type changed — stop its schedule
    unscheduleTrigger(triggerId);
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

// ── Agent Heartbeat System ───────────────────────────────────────

const HEARTBEAT_PROMPT = `Quick status check. Review your responsibilities and recent activity. Report any:
- Pending items that need the user's attention
- Monitoring results that changed since last check
- Upcoming scheduled tasks or deadlines

Keep your response to 2-3 sentences. Say "All clear" if nothing needs attention.`;

/**
 * Auto-create heartbeat triggers for agents that have a scheduleInterval.
 * Runs once at startup — syncs agent heartbeat triggers with their scheduleInterval.
 */
async function startAgentHeartbeatScheduler(): Promise<void> {
  try {
    // Find all agents with a scheduleInterval set
    const agents = await Agent.find({
      scheduleInterval: { $exists: true, $gt: 0 },
      isPublished: true,
    }).select('_id name author scheduleInterval systemPrompt').lean();

    if (agents.length === 0) {
      log.triggers.info('No agents with heartbeat schedules found');
      return;
    }

    log.triggers.info({ count: agents.length }, 'Syncing agent heartbeat triggers');

    for (const agent of agents) {
      // Check if a heartbeat trigger already exists for this agent
      const existing = await Trigger.findOne({
        type: 'agent_heartbeat',
        'action.agentId': agent._id,
        enabled: true,
      });

      if (existing) {
        // Ensure schedule matches agent's interval
        const expectedCron = `*/${agent.scheduleInterval} * * * *`;
        if (existing.schedule?.cron !== expectedCron) {
          existing.schedule = { type: 'cron', cron: expectedCron };
          await existing.save();
          scheduleTrigger(existing);
          log.triggers.info({ agentName: agent.name, interval: agent.scheduleInterval }, 'Updated heartbeat schedule');
        }
        continue;
      }

      // Create a new heartbeat trigger for this agent
      const trigger = await Trigger.create({
        oxyUserId: agent.author,
        name: `${agent.name} Heartbeat`,
        description: `Periodic heartbeat check for ${agent.name}`,
        type: 'agent_heartbeat' as TriggerType,
        enabled: true,
        action: {
          prompt: HEARTBEAT_PROMPT,
          agentId: agent._id,
          useTools: false,
          notify: true,
        },
        schedule: {
          type: 'cron',
          cron: `*/${agent.scheduleInterval} * * * *`,
        },
        triggerCount: 0,
      });

      scheduleTrigger(trigger);
      log.triggers.info({ agentName: agent.name, interval: agent.scheduleInterval }, 'Created heartbeat trigger');
    }
  } catch (error) {
    log.triggers.error({ err: error }, 'Failed to sync agent heartbeat triggers');
  }
}
