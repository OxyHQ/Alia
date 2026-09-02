import { uuidv7 } from '@oxyhq/db';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { findAgentById } from '../db/agents/agentRepository.js';
import {
  createAutomationDefinition,
  findAutomationDefinition,
  listActiveAutomationAuthorizations,
  listAutomationDefinitions,
  listAutomationRuns,
  listAutomationRunSteps,
  markAutomationAuthorizationsRevoked,
  setAutomationEnabled,
  upsertAutomationActionAuthorizations,
} from '../db/automation/automationDefinitionRepository.js';
import { getDb } from '../db/index.js';
import {
  provisionAutomationAuthorizations,
  revokeAutomationAuthorizations,
  type ProvisionedAutomationAuthorization,
} from '../lib/automation-authority.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';

const resourceSchema = z.object({
  appId: z.string().min(1),
  effectiveAccountId: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
}).strict();
const limitSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]),
}).strict();
const actionLimitSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.number().finite(), z.boolean()]),
}).strict();
const actionSchema = z.object({
  resource: resourceSchema,
  tool: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  limits: z.array(actionLimitSchema).default([]),
}).strict();
const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({
    type: z.literal('event'),
    appId: z.string().min(1),
    eventType: z.string().min(1),
    resource: resourceSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }).strict(),
]);
const actorSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), agentId: z.string().min(1) }).strict(),
  z.object({
    mode: z.literal('automatic'),
    eligibleAgentIds: z.array(z.string().min(1)).min(1),
  }).strict(),
]);
const createSchema = z.object({
  objective: z.string().trim().min(1),
  trigger: triggerSchema,
  actorSelection: actorSelectionSchema,
  executionMode: z.enum(['observe', 'execute']).default('observe'),
  actions: z.array(actionSchema).min(1),
  inputs: z.record(z.unknown()).default({}),
  resources: z.array(resourceSchema).default([]),
  dataFlow: z.object({
    sources: z.array(resourceSchema),
    destinations: z.array(resourceSchema),
  }).strict(),
  maximumAutonomy: z.enum(['read_only', 'draft', 'execute_on_request', 'autonomous']),
  limits: z.array(limitSchema).default([]),
  enabled: z.boolean().default(true),
}).strict();

type AutomationRecord = NonNullable<Awaited<ReturnType<typeof findAutomationDefinition>>>;
type ParsedAction = z.infer<typeof actionSchema>;

const router = Router();
router.use(authenticateToken);

function userId(request: Request): string | null {
  return request.user?.id ?? null;
}

async function ownedAgents(ownerAccountId: string, agentIds: readonly string[]) {
  const agents = await Promise.all(agentIds.map((agentId) => findAgentById(getDb(), agentId)));
  if (!agents.every((agent, index) => (
    agent !== null && agent.author === ownerAccountId && agent.id === agentIds[index]
  ))) return null;
  return agents.filter((agent): agent is NonNullable<typeof agent> => agent !== null);
}

function sameResource(
  left: z.infer<typeof resourceSchema>,
  right: z.infer<typeof resourceSchema>,
): boolean {
  return left.appId === right.appId
    && left.effectiveAccountId === right.effectiveAccountId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId;
}

function actionKey(action: ParsedAction): string {
  return JSON.stringify([
    action.resource.appId,
    action.resource.effectiveAccountId,
    action.resource.resourceType,
    action.resource.resourceId,
    action.tool,
  ]);
}

async function revokeProvisioned(
  accessToken: string | undefined,
  provisioned: readonly ProvisionedAutomationAuthorization[],
): Promise<void> {
  if (!accessToken || provisioned.length === 0) return;
  const result = await revokeAutomationAuthorizations(
    accessToken,
    provisioned.map((authorization) => authorization.oxyAuthorizationId),
  );
  if (result.failed.length > 0) {
    log.triggers.error(
      { failed: result.failed.length },
      'Failed to compensate some newly provisioned Oxy automation authorizations',
    );
  }
}

async function persistAuthorityAndActivate(input: {
  automationId: string;
  ownerAccountId: string;
  provisioned: readonly ProvisionedAutomationAuthorization[];
}): Promise<AutomationRecord> {
  return getDb().transaction(async (transaction) => {
    await upsertAutomationActionAuthorizations(transaction, input.provisioned);
    const automation = await setAutomationEnabled(
      transaction,
      input.automationId,
      input.ownerAccountId,
      true,
    );
    if (!automation) throw new Error('Persisted automation disappeared before activation');
    return automation;
  });
}

async function stopAutomation(input: {
  request: Request;
  ownerAccountId: string;
  automation: AutomationRecord;
}) {
  const stopped = await setAutomationEnabled(getDb(), input.automation.id, input.ownerAccountId, false);
  const active = await listActiveAutomationAuthorizations(getDb(), input.automation.id);
  if (active.length === 0) return { automation: stopped, revoked: 0, failed: 0 };
  if (!input.request.accessToken) {
    log.triggers.error(
      { automationId: input.automation.id, count: active.length },
      'Automation stopped locally but no user session was available to revoke Oxy authority',
    );
    return { automation: stopped, revoked: 0, failed: active.length };
  }
  const result = await revokeAutomationAuthorizations(
    input.request.accessToken,
    active.map((authorization) => authorization.oxyAuthorizationId),
  );
  await markAutomationAuthorizationsRevoked(getDb(), result.revoked);
  if (result.failed.length > 0) {
    log.triggers.error(
      { automationId: input.automation.id, failed: result.failed.length },
      'Automation stopped locally; some Oxy authorizations still require revocation',
    );
  }
  return { automation: stopped, revoked: result.revoked.length, failed: result.failed.length };
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
  if (!parsed.success) {
    return response.status(400).json({ error: 'invalid_automation', details: parsed.error.flatten() });
  }
  if (parsed.data.trigger.type === 'event' && parsed.data.dataFlow.sources.length === 0) {
    return response.status(400).json({ error: 'event_automation_requires_explicit_data_source' });
  }
  if (parsed.data.actions.some((action) => (
    !parsed.data.resources.some((resource) => sameResource(resource, action.resource))
  ))) {
    return response.status(400).json({ error: 'automation_action_resource_not_declared' });
  }
  if (new Set(parsed.data.actions.map(actionKey)).size !== parsed.data.actions.length) {
    return response.status(400).json({ error: 'duplicate_automation_action' });
  }
  if (parsed.data.actions.some((action) => (
    new Set(action.limits.map((limit) => limit.key)).size !== action.limits.length
  ))) {
    return response.status(400).json({ error: 'duplicate_automation_action_limit' });
  }

  const selection = parsed.data.actorSelection;
  const agentIds = selection.mode === 'fixed' ? [selection.agentId] : selection.eligibleAgentIds;
  if (new Set(agentIds).size !== agentIds.length) {
    return response.status(400).json({ error: 'duplicate_automation_agent' });
  }
  const agents = await ownedAgents(ownerAccountId, agentIds);
  if (!agents) return response.status(403).json({ error: 'automation_agent_not_owned' });
  if (parsed.data.executionMode === 'execute' && parsed.data.enabled && !request.accessToken) {
    return response.status(401).json({ error: 'user_session_required_for_execution_authority' });
  }

  const automationId = uuidv7();
  const actions = parsed.data.actions.map((action) => ({ id: uuidv7(), ...action }));
  const trigger = parsed.data.trigger;
  let automation: Awaited<ReturnType<typeof createAutomationDefinition>>;
  try {
    automation = await createAutomationDefinition(getDb(), {
      id: automationId,
      ownerAccountId,
      objective: parsed.data.objective,
      triggerKind: trigger.type,
      ...(trigger.type === 'event' ? {
        eventAppId: trigger.appId,
        eventType: trigger.eventType,
        eventResource: trigger.resource,
      } : {}),
      ...(trigger.type === 'schedule' ? {
        scheduleCron: trigger.cron,
        scheduleTimezone: trigger.timezone,
      } : {}),
      actorMode: selection.mode,
      fixedAgentId: selection.mode === 'fixed' ? selection.agentId : undefined,
      eligibleAgentIds: selection.mode === 'automatic' ? selection.eligibleAgentIds : [],
      executionMode: parsed.data.executionMode,
      actions,
      inputs: parsed.data.inputs,
      resources: parsed.data.resources,
      dataFlow: parsed.data.dataFlow,
      maximumAutonomy: parsed.data.maximumAutonomy,
      limits: parsed.data.limits,
      // Execute definitions stay inert until every remote authorization is
      // durably referenced below. Observation needs no remote state.
      enabled: parsed.data.executionMode === 'observe' ? parsed.data.enabled : false,
    });
  } catch (error: unknown) {
    log.triggers.error({ err: error, ownerAccountId }, 'Could not persist automation definition');
    return response.status(503).json({ error: 'automation_store_unavailable' });
  }

  if (parsed.data.executionMode === 'execute' && parsed.data.enabled && request.accessToken) {
    let provisioned: ProvisionedAutomationAuthorization[];
    try {
      provisioned = await provisionAutomationAuthorizations({
        accessToken: request.accessToken,
        ownerAccountId,
        automationId,
        maximumAutonomy: parsed.data.maximumAutonomy,
        agents: agents.map((agent) => ({ agentId: agent.id, actorAccountId: agent.oxyAccountId })),
        actions,
      });
    } catch (error: unknown) {
      log.triggers.warn({ err: error, ownerAccountId, automationId }, 'Oxy refused automation execution authority');
      return response.status(403).json({
        error: 'automation_execution_authority_refused',
        automationId,
        stopped: true,
      });
    }
    try {
      automation = await persistAuthorityAndActivate({
        automationId,
        ownerAccountId,
        provisioned,
      });
    } catch (error: unknown) {
      await revokeProvisioned(request.accessToken, provisioned);
      log.triggers.error({ err: error, ownerAccountId, automationId }, 'Could not persist automation authority');
      return response.status(503).json({
        error: 'automation_store_unavailable',
        automationId,
        stopped: true,
      });
    }
  }

  return response.status(201).json({
    automation,
    receipt: {
      trigger: automation.trigger,
      actors: automation.actorSelection,
      executionMode: automation.executionMode,
      actions: automation.actions,
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
  if (!runs.some((run) => run.id === request.params.runId)) {
    return response.status(404).json({ error: 'Run not found' });
  }
  return response.json({ steps: await listAutomationRunSteps(getDb(), String(request.params.runId)) });
});

router.patch('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_automation_patch' });
  const existing = await findAutomationDefinition(getDb(), String(request.params.id), ownerAccountId);
  if (!existing) return response.status(404).json({ error: 'Automation not found' });
  if (existing.enabled === parsed.data.enabled) return response.json({ automation: existing });

  if (!parsed.data.enabled) {
    const stopped = await stopAutomation({ request, ownerAccountId, automation: existing });
    return response.json({
      automation: stopped.automation,
      stopped: true,
      revocation: { revoked: stopped.revoked, failed: stopped.failed },
    });
  }

  if (existing.executionMode === 'execute') {
    if (!request.accessToken) {
      return response.status(401).json({ error: 'user_session_required_for_execution_authority' });
    }
    const agentIds = existing.actorSelection.mode === 'fixed'
      ? [existing.actorSelection.agentId].filter((id): id is string => Boolean(id))
      : existing.actorSelection.eligibleAgentIds;
    const agents = await ownedAgents(ownerAccountId, agentIds);
    if (!agents) return response.status(403).json({ error: 'automation_agent_not_owned' });
    let provisioned: ProvisionedAutomationAuthorization[];
    try {
      provisioned = await provisionAutomationAuthorizations({
        accessToken: request.accessToken,
        ownerAccountId,
        automationId: existing.id,
        maximumAutonomy: existing.maximumAutonomy,
        agents: agents.map((agent) => ({ agentId: agent.id, actorAccountId: agent.oxyAccountId })),
        actions: existing.actions,
      });
    } catch (error: unknown) {
      log.triggers.warn({ err: error, automationId: existing.id }, 'Oxy refused restored automation authority');
      return response.status(403).json({ error: 'automation_execution_authority_refused' });
    }
    try {
      const automation = await persistAuthorityAndActivate({
        automationId: existing.id,
        ownerAccountId,
        provisioned,
      });
      return response.json({ automation });
    } catch (error: unknown) {
      await revokeProvisioned(request.accessToken, provisioned);
      log.triggers.error({ err: error, automationId: existing.id }, 'Could not persist restored automation authority');
      return response.status(503).json({ error: 'automation_store_unavailable' });
    }
  }
  const automation = await setAutomationEnabled(getDb(), existing.id, ownerAccountId, true);
  return response.json({ automation });
});

router.delete('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const existing = await findAutomationDefinition(getDb(), String(request.params.id), ownerAccountId);
  if (!existing) return response.status(404).json({ error: 'Automation not found' });
  const stopped = await stopAutomation({ request, ownerAccountId, automation: existing });
  log.triggers.info({ automationId: existing.id, ownerAccountId }, 'Automation stopped');
  return response.json({
    automation: stopped.automation,
    stopped: true,
    revocation: { revoked: stopped.revoked, failed: stopped.failed },
  });
});

export default router;
