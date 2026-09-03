import { uuidv7 } from '@oxyhq/db';
import { z } from 'zod';
import { findAgentById } from '../db/agents/agentRepository.js';
import {
  createAutomationDefinition,
  listActiveAutomationAuthorizations,
  markAutomationAuthorizationsRevoked,
  setAutomationEnabled,
  updateAutomationDefinition,
  type AutomationDefinitionRecord,
  upsertAutomationActionAuthorizations,
} from '../db/automation/automationDefinitionRepository.js';
import { getDb } from '../db/index.js';
import {
  provisionAutomationAuthorizations,
  revokeAutomationAuthorizations,
  type ProvisionedAutomationAuthorization,
} from './automation-authority.js';
import {
  loadAutomationActorCandidates,
  planAutomationStages,
  provisionableAutomationPairs,
  uniqueAutomationResources,
  type AutomationActionPlanInput,
} from './automation-coordination.js';
import { automationExecutionPolicyError } from './automation-execution-policy.js';
import { log } from './logger.js';
import { automationReceipt } from './structured-automation.js';
import { automationScheduleError, reloadAutomationSchedule } from './trigger-engine.js';

export const automationResourceSchema = z.object({
  appId: z.string().min(1).describe('Stable Oxy app identifier, such as inbox or noted'),
  effectiveAccountId: z.string().min(1).describe('Exact Oxy account that owns the public action'),
  resourceType: z.string().min(1).describe('Resource kind declared by the app catalogue'),
  resourceId: z.string().min(1).describe('Exact resource identifier within the effective account'),
}).strict();

export const automationLimitSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]),
}).strict();

const automationLimitsSchema = z.array(automationLimitSchema).superRefine((limits, context) => {
  const keys = new Set<string>();
  limits.forEach((limit, index) => {
    if (keys.has(limit.key)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'key'],
        message: 'Limit keys must be unique',
      });
    }
    keys.add(limit.key);
  });
});

const automationActionLimitSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.number().finite(), z.boolean()]),
}).strict();

const automationActionSchema = z.object({
  resource: automationResourceSchema,
  tool: z.string().min(1).describe('Exact stable tool name from the app capability catalogue'),
  input: z.record(z.string(), z.unknown()).default({}),
  limits: z.array(automationActionLimitSchema).default([]),
}).strict();

export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({
    type: z.literal('event'),
    appId: z.string().min(1),
    eventType: z.string().min(1),
    resource: automationResourceSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1).describe('Five-field cron expression'),
    timezone: z.string().min(1).describe('IANA timezone, such as Europe/Madrid'),
  }).strict(),
]);

export const automationActorSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), agentId: z.string().min(1) }).strict(),
  z.object({
    mode: z.literal('automatic'),
    eligibleAgentIds: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

export const createAutomationSchema = z.object({
  objective: z.string().trim().min(1).describe('What the automation must accomplish'),
  trigger: automationTriggerSchema,
  actorSelection: automationActorSelectionSchema,
  executionMode: z.enum(['observe', 'execute']).default('observe')
    .describe('Use execute only when the user explicitly asked for real actions'),
  actions: z.array(automationActionSchema).min(1)
    .describe('Ordered app actions; use exact resource and catalogue tool names'),
  inputs: z.record(z.string(), z.unknown()).default({}),
  resources: z.array(automationResourceSchema).default([]),
  dataFlow: z.object({
    sources: z.array(automationResourceSchema),
    destinations: z.array(automationResourceSchema),
  }).strict(),
  maximumAutonomy: z.enum(['read_only', 'draft', 'execute_on_request', 'autonomous']),
  limits: automationLimitsSchema.default([]),
  enabled: z.boolean().default(true),
}).strict();

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z.object({
  objective: createAutomationSchema.shape.objective.optional(),
  trigger: automationTriggerSchema.optional(),
  actorSelection: automationActorSelectionSchema.optional(),
  resources: z.array(automationResourceSchema).optional(),
  dataFlow: createAutomationSchema.shape.dataFlow.optional(),
  maximumAutonomy: createAutomationSchema.shape.maximumAutonomy.optional(),
  limits: automationLimitsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one editable field is required',
});

export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

type AutomationRecord = Awaited<ReturnType<typeof createAutomationDefinition>>;

export class AutomationCreationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 409 | 503,
    readonly context: { automationId?: string; stopped?: boolean } = {},
  ) {
    super(code);
    this.name = 'AutomationCreationError';
  }
}

export async function ownedAutomationAgents(ownerAccountId: string, agentIds: readonly string[]) {
  const agents = await Promise.all(agentIds.map((agentId) => findAgentById(getDb(), agentId)));
  if (!agents.every((agent, index) => (
    agent !== null && agent.author === ownerAccountId && agent.id === agentIds[index]
  ))) return null;
  return agents.filter((agent): agent is NonNullable<typeof agent> => agent !== null);
}

export async function executionAuthorityPairs(input: {
  ownerAccountId: string;
  agents: NonNullable<Awaited<ReturnType<typeof findAgentById>>>[];
  actions: readonly AutomationActionPlanInput[];
  sourceResources: CreateAutomationInput['dataFlow']['sources'];
  requiredAutonomy: CreateAutomationInput['maximumAutonomy'];
}) {
  const candidates = await loadAutomationActorCandidates(
    input.ownerAccountId,
    input.agents,
    input.requiredAutonomy,
  );
  const plan = planAutomationStages({
    candidates,
    sourceResources: input.sourceResources,
    actions: input.actions,
    requiredAutonomy: input.requiredAutonomy,
  });
  if (!plan) return null;
  return provisionableAutomationPairs({
    candidates,
    actions: input.actions,
    requiredAutonomy: input.requiredAutonomy,
  });
}

export async function revokeProvisionedAutomationAuthority(
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

export async function persistAutomationAuthorityAndActivate(input: {
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

export async function refreshAutomationSchedule(automationId: string): Promise<void> {
  try {
    await reloadAutomationSchedule(automationId);
  } catch (error: unknown) {
    // Persistence is authoritative; the elected scheduler reconciles every 30 seconds.
    log.triggers.warn({ err: error, automationId }, 'Immediate automation schedule refresh failed');
  }
}

function sameResource(
  left: z.infer<typeof automationResourceSchema>,
  right: z.infer<typeof automationResourceSchema>,
): boolean {
  return left.appId === right.appId
    && left.effectiveAccountId === right.effectiveAccountId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId;
}

function actionKey(action: CreateAutomationInput['actions'][number]): string {
  return JSON.stringify([
    action.resource.appId,
    action.resource.effectiveAccountId,
    action.resource.resourceType,
    action.resource.resourceId,
    action.tool,
  ]);
}

function validateDefinition(definition: CreateAutomationInput): void {
  const executionPolicyError = automationExecutionPolicyError({
    enabled: definition.enabled,
    executionMode: definition.executionMode,
    maximumAutonomy: definition.maximumAutonomy,
    triggerType: definition.trigger.type,
  });
  if (executionPolicyError) throw new AutomationCreationError(executionPolicyError, 400);
  if (definition.trigger.type === 'event' && definition.dataFlow.sources.length === 0) {
    throw new AutomationCreationError('event_automation_requires_explicit_data_source', 400);
  }
  if (definition.trigger.type === 'schedule') {
    const scheduleError = automationScheduleError(
      definition.trigger.cron,
      definition.trigger.timezone,
    );
    if (scheduleError) throw new AutomationCreationError(scheduleError, 400);
  }
  if (definition.actions.some((action) => (
    !definition.resources.some((resource) => sameResource(resource, action.resource))
  ))) {
    throw new AutomationCreationError('automation_action_resource_not_declared', 400);
  }
  if (new Set(definition.actions.map(actionKey)).size !== definition.actions.length) {
    throw new AutomationCreationError('duplicate_automation_action', 400);
  }
  if (definition.actions.some((action) => (
    new Set(action.limits.map((limit) => limit.key)).size !== action.limits.length
  ))) {
    throw new AutomationCreationError('duplicate_automation_action_limit', 400);
  }
}

function editableDefinition(
  existing: AutomationDefinitionRecord,
  patch: UpdateAutomationInput,
): CreateAutomationInput {
  const merged = createAutomationSchema.safeParse({
    objective: patch.objective ?? existing.objective,
    trigger: patch.trigger ?? existing.trigger,
    actorSelection: patch.actorSelection ?? existing.actorSelection,
    executionMode: existing.executionMode,
    actions: existing.actions.map((action) => ({
      resource: action.resource,
      tool: action.tool,
      input: action.input,
      limits: action.limits,
    })),
    inputs: existing.inputs,
    resources: patch.resources ?? existing.resources,
    dataFlow: patch.dataFlow ?? existing.dataFlow,
    maximumAutonomy: patch.maximumAutonomy ?? existing.maximumAutonomy,
    limits: patch.limits ?? existing.limits,
    enabled: patch.enabled ?? existing.enabled,
  });
  if (!merged.success) {
    throw new AutomationCreationError('invalid_automation_patch', 400);
  }
  return merged.data;
}

async function stopAndRevokeCurrentAuthority(input: {
  accessToken?: string;
  automation: AutomationDefinitionRecord;
}): Promise<{ updatedAt: Date; revoked: number }> {
  const active = await listActiveAutomationAuthorizations(getDb(), input.automation.id);
  if (active.length > 0 && !input.accessToken) {
    throw new AutomationCreationError('user_session_required_for_execution_authority', 401);
  }
  const stopped = input.automation.enabled
    ? await setAutomationEnabled(
      getDb(),
      input.automation.id,
      input.automation.ownerAccountId,
      false,
      input.automation.updatedAt,
    )
    : input.automation;
  if (!stopped) throw new AutomationCreationError('automation_concurrent_update', 409);
  if (active.length === 0 || !input.accessToken) {
    return { updatedAt: stopped.updatedAt, revoked: 0 };
  }

  const revoked = await revokeAutomationAuthorizations(
    input.accessToken,
    active.map((authorization) => authorization.oxyAuthorizationId),
  );
  await markAutomationAuthorizationsRevoked(getDb(), revoked.revoked);
  if (revoked.failed.length > 0) {
    throw new AutomationCreationError(
      'automation_authority_revocation_incomplete',
      503,
      { automationId: input.automation.id, stopped: true },
    );
  }
  return { updatedAt: stopped.updatedAt, revoked: revoked.revoked.length };
}

/**
 * Update one structured definition without changing its exact action ids.
 * Active authority is recreated from the merged definition, the automation is
 * stopped before old authority is revoked, and it is re-enabled only after the
 * new references and editable fields commit together.
 */
export async function updateStructuredAutomation(input: {
  ownerAccountId: string;
  accessToken?: string;
  existing: AutomationDefinitionRecord;
  patch: UpdateAutomationInput;
}) {
  if (input.existing.legacyTriggerId) {
    throw new AutomationCreationError('legacy_automation_not_editable', 409);
  }
  const definition = editableDefinition(input.existing, input.patch);
  const executionPolicyError = automationExecutionPolicyError({
    enabled: definition.enabled,
    executionMode: definition.executionMode,
    maximumAutonomy: definition.maximumAutonomy,
    triggerType: definition.trigger.type,
  });
  if (executionPolicyError) throw new AutomationCreationError(executionPolicyError, 409);
  validateDefinition(definition);
  const selection = definition.actorSelection;
  const agentIds = selection.mode === 'fixed' ? [selection.agentId] : selection.eligibleAgentIds;
  if (new Set(agentIds).size !== agentIds.length) {
    throw new AutomationCreationError('duplicate_automation_agent', 400);
  }
  const agents = await ownedAutomationAgents(input.ownerAccountId, agentIds);
  if (!agents) throw new AutomationCreationError('automation_agent_not_owned', 403);
  if (definition.executionMode === 'execute' && definition.enabled && !input.accessToken) {
    throw new AutomationCreationError('user_session_required_for_execution_authority', 401);
  }

  const sourceResources = uniqueAutomationResources([
    ...(definition.trigger.type === 'event' && definition.trigger.resource
      ? [definition.trigger.resource]
      : []),
    ...definition.dataFlow.sources,
  ]);
  const authorityPairs = definition.executionMode === 'execute' && definition.enabled
    ? await executionAuthorityPairs({
      ownerAccountId: input.ownerAccountId,
      agents,
      actions: input.existing.actions,
      sourceResources,
      requiredAutonomy: definition.maximumAutonomy,
    })
    : [];
  if (authorityPairs === null) {
    throw new AutomationCreationError('automation_actor_coverage_missing', 403);
  }

  let provisioned: ProvisionedAutomationAuthorization[] = [];
  if (definition.executionMode === 'execute' && definition.enabled && input.accessToken) {
    try {
      provisioned = await provisionAutomationAuthorizations({
        accessToken: input.accessToken,
        ownerAccountId: input.ownerAccountId,
        automationId: input.existing.id,
        maximumAutonomy: definition.maximumAutonomy,
        pairs: authorityPairs,
      });
    } catch (error: unknown) {
      log.triggers.warn(
        { err: error, automationId: input.existing.id },
        'Oxy refused updated automation authority',
      );
      throw new AutomationCreationError('automation_execution_authority_refused', 403);
    }
  }

  let stopped: { updatedAt: Date; revoked: number };
  try {
    stopped = await stopAndRevokeCurrentAuthority({
      accessToken: input.accessToken,
      automation: input.existing,
    });
  } catch (error: unknown) {
    await revokeProvisionedAutomationAuthority(input.accessToken, provisioned);
    throw error;
  }

  const trigger = definition.trigger;
  let automation: AutomationDefinitionRecord | null;
  try {
    automation = await updateAutomationDefinition(getDb(), {
      id: input.existing.id,
      ownerAccountId: input.ownerAccountId,
      expectedUpdatedAt: stopped.updatedAt,
      objective: definition.objective,
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
      resources: definition.resources,
      dataFlow: definition.dataFlow,
      maximumAutonomy: definition.maximumAutonomy,
      limits: definition.limits,
      enabled: definition.enabled,
      authorizations: provisioned,
    });
  } catch (error: unknown) {
    await revokeProvisionedAutomationAuthority(input.accessToken, provisioned);
    log.triggers.error(
      { err: error, automationId: input.existing.id },
      'Could not persist updated automation',
    );
    throw new AutomationCreationError(
      'automation_store_unavailable',
      503,
      { automationId: input.existing.id, stopped: true },
    );
  }
  if (!automation) {
    await revokeProvisionedAutomationAuthority(input.accessToken, provisioned);
    throw new AutomationCreationError(
      'automation_concurrent_update',
      409,
      { automationId: input.existing.id, stopped: true },
    );
  }

  await refreshAutomationSchedule(automation.id);
  return {
    automation,
    receipt: automationReceipt(automation),
    revocation: { revoked: stopped.revoked, failed: 0 },
  };
}

/**
 * The single creation path for HTTP and conversational requests. The live user
 * bearer is used only while asking Oxy for durable, opaque authorization ids.
 */
export async function createStructuredAutomation(input: {
  ownerAccountId: string;
  accessToken?: string;
  definition: CreateAutomationInput;
}) {
  validateDefinition(input.definition);
  const selection = input.definition.actorSelection;
  const agentIds = selection.mode === 'fixed' ? [selection.agentId] : selection.eligibleAgentIds;
  if (new Set(agentIds).size !== agentIds.length) {
    throw new AutomationCreationError('duplicate_automation_agent', 400);
  }
  const agents = await ownedAutomationAgents(input.ownerAccountId, agentIds);
  if (!agents) throw new AutomationCreationError('automation_agent_not_owned', 403);
  if (input.definition.executionMode === 'execute' && input.definition.enabled && !input.accessToken) {
    throw new AutomationCreationError('user_session_required_for_execution_authority', 401);
  }

  const automationId = uuidv7();
  const actions = input.definition.actions.map((action) => ({ id: uuidv7(), ...action }));
  const trigger = input.definition.trigger;
  const sourceResources = uniqueAutomationResources([
    ...(trigger.type === 'event' && trigger.resource ? [trigger.resource] : []),
    ...input.definition.dataFlow.sources,
  ]);
  const authorityPairs = input.definition.executionMode === 'execute' && input.definition.enabled
    ? await executionAuthorityPairs({
      ownerAccountId: input.ownerAccountId,
      agents,
      actions,
      sourceResources,
      requiredAutonomy: input.definition.maximumAutonomy,
    })
    : [];
  if (authorityPairs === null) {
    throw new AutomationCreationError('automation_actor_coverage_missing', 403);
  }

  let automation: AutomationRecord;
  try {
    automation = await createAutomationDefinition(getDb(), {
      id: automationId,
      ownerAccountId: input.ownerAccountId,
      objective: input.definition.objective,
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
      executionMode: input.definition.executionMode,
      actions,
      inputs: input.definition.inputs,
      resources: input.definition.resources,
      dataFlow: input.definition.dataFlow,
      maximumAutonomy: input.definition.maximumAutonomy,
      limits: input.definition.limits,
      // Execute definitions remain inert until every remote authorization is durable.
      enabled: input.definition.executionMode === 'observe' ? input.definition.enabled : false,
    });
  } catch (error: unknown) {
    log.triggers.error({ err: error, ownerAccountId: input.ownerAccountId }, 'Could not persist automation definition');
    throw new AutomationCreationError('automation_store_unavailable', 503);
  }

  if (input.definition.executionMode === 'execute' && input.definition.enabled && input.accessToken) {
    let provisioned: ProvisionedAutomationAuthorization[];
    try {
      provisioned = await provisionAutomationAuthorizations({
        accessToken: input.accessToken,
        ownerAccountId: input.ownerAccountId,
        automationId,
        maximumAutonomy: input.definition.maximumAutonomy,
        pairs: authorityPairs,
      });
    } catch (error: unknown) {
      log.triggers.warn(
        { err: error, ownerAccountId: input.ownerAccountId, automationId },
        'Oxy refused automation execution authority',
      );
      throw new AutomationCreationError(
        'automation_execution_authority_refused',
        403,
        { automationId, stopped: true },
      );
    }
    try {
      automation = await persistAutomationAuthorityAndActivate({
        automationId,
        ownerAccountId: input.ownerAccountId,
        provisioned,
      });
    } catch (error: unknown) {
      await revokeProvisionedAutomationAuthority(input.accessToken, provisioned);
      log.triggers.error(
        { err: error, ownerAccountId: input.ownerAccountId, automationId },
        'Could not persist automation authority',
      );
      throw new AutomationCreationError(
        'automation_store_unavailable',
        503,
        { automationId, stopped: true },
      );
    }
  }

  await refreshAutomationSchedule(automation.id);
  return { automation, receipt: automationReceipt(automation) };
}
