import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  createAutomationDefinition,
  findAutomationDefinition,
  listAutomationDefinitions,
  listAutomationRuns,
  listAutomationRunSteps,
  setAutomationEnabled,
} from '../db/automation/automationDefinitionRepository.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const resourceSchema = z.object({
  appId: z.string().min(1), effectiveAccountId: z.string().min(1),
  resourceType: z.string().min(1), resourceId: z.string().min(1),
}).strict();
const limitSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]),
}).strict();
const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({
    type: z.literal('event'), appId: z.string().min(1), eventType: z.string().min(1),
    resource: resourceSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('schedule'), cron: z.string().min(1), timezone: z.string().min(1),
  }).strict(),
]);
const actorSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), agentId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('automatic'), eligibleAgentIds: z.array(z.string().min(1)).default([]) }).strict(),
]);
const createSchema = z.object({
  objective: z.string().trim().min(1),
  trigger: triggerSchema,
  actorSelection: actorSelectionSchema,
  inputs: z.record(z.unknown()).default({}),
  resources: z.array(resourceSchema).default([]),
  dataFlow: z.object({ sources: z.array(resourceSchema), destinations: z.array(resourceSchema) }).strict(),
  maximumAutonomy: z.enum(['read_only', 'draft', 'execute_on_request', 'autonomous']),
  limits: z.array(limitSchema).default([]),
  enabled: z.boolean().default(true),
}).strict();

const router = Router();
router.use(authenticateToken);

function userId(request: Request): string | null {
  return request.user?.id ?? null;
}

async function agentsBelongToOwner(ownerAccountId: string, agentIds: readonly string[]): Promise<boolean> {
  const agents = await Promise.all(agentIds.map((agentId) => findAgentById(getDb(), agentId)));
  return agents.every((agent, index) => agent !== null && agent.author === ownerAccountId && agent.id === agentIds[index]);
}

router.get('/', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  return response.json({ automations: await listAutomationDefinitions(getDb(), ownerAccountId) });
});

router.post('/', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_automation', details: parsed.error.flatten() });
  if (parsed.data.trigger.type === 'event' && parsed.data.dataFlow.sources.length === 0) {
    return response.status(400).json({
      error: 'event_automation_requires_explicit_data_source',
    });
  }
  const selection = parsed.data.actorSelection;
  const agentIds = selection.mode === 'fixed' ? [selection.agentId] : selection.eligibleAgentIds;
  if (!await agentsBelongToOwner(ownerAccountId, agentIds)) {
    return response.status(403).json({ error: 'automation_agent_not_owned' });
  }
  const trigger = parsed.data.trigger;
  const automation = await createAutomationDefinition(getDb(), {
    ownerAccountId,
    objective: parsed.data.objective,
    triggerKind: trigger.type,
    ...(trigger.type === 'event' ? {
      eventAppId: trigger.appId, eventType: trigger.eventType, eventResource: trigger.resource,
    } : {}),
    ...(trigger.type === 'schedule' ? {
      scheduleCron: trigger.cron, scheduleTimezone: trigger.timezone,
    } : {}),
    actorMode: selection.mode,
    fixedAgentId: selection.mode === 'fixed' ? selection.agentId : undefined,
    eligibleAgentIds: selection.mode === 'automatic' ? selection.eligibleAgentIds : [],
    inputs: parsed.data.inputs,
    resources: parsed.data.resources,
    dataFlow: parsed.data.dataFlow,
    maximumAutonomy: parsed.data.maximumAutonomy,
    limits: parsed.data.limits,
    enabled: parsed.data.enabled,
  });
  return response.status(201).json({
    automation,
    receipt: {
      trigger: automation.trigger,
      actors: automation.actorSelection,
      resources: automation.resources,
      dataFlow: automation.dataFlow,
      maximumAutonomy: automation.maximumAutonomy,
      limits: automation.limits,
      undo: { method: 'DELETE', path: `/automations/${automation.id}` },
    },
  });
});

router.get('/runs', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const automationId = typeof request.query.automationId === 'string' ? request.query.automationId : undefined;
  return response.json({ runs: await listAutomationRuns(getDb(), ownerAccountId, automationId) });
});

router.get('/runs/:runId/steps', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const runs = await listAutomationRuns(getDb(), ownerAccountId);
  if (!runs.some((run) => run.id === request.params.runId)) return response.status(404).json({ error: 'Run not found' });
  return response.json({ steps: await listAutomationRunSteps(getDb(), String(request.params.runId)) });
});

router.patch('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_automation_patch' });
  const automation = await setAutomationEnabled(getDb(), String(request.params.id), ownerAccountId, parsed.data.enabled);
  if (!automation) return response.status(404).json({ error: 'Automation not found' });
  return response.json({ automation });
});

router.delete('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const existing = await findAutomationDefinition(getDb(), String(request.params.id), ownerAccountId);
  if (!existing) return response.status(404).json({ error: 'Automation not found' });
  const automation = await setAutomationEnabled(getDb(), existing.id, ownerAccountId, false);
  log.triggers.info({ automationId: existing.id, ownerAccountId }, 'Automation stopped');
  return response.json({ automation, stopped: true });
});

export default router;
