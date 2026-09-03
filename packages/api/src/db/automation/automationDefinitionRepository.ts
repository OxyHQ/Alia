import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ApiDatabase, Executor } from '../index';
import {
  automationActionAuthorizations,
  automationActions,
  automationActorAssignments,
  automationDefinitions,
  automationEvents,
  automationRuns,
  automationSteps,
  type AutomationActionLimit,
  type AutomationDataFlow,
  type AutomationLimit,
  type AutomationResourceRef,
} from '../schema/agency';
import { agentSessions } from '../schema/agent-sessions';

type DefinitionRow = typeof automationDefinitions.$inferSelect;
type ActionRow = typeof automationActions.$inferSelect;

export interface AutomationActionInput {
  id: string;
  resource: AutomationResourceRef;
  tool: string;
  input: Record<string, unknown>;
  limits: AutomationActionLimit[];
}

export interface AutomationDefinitionInput {
  ownerAccountId: string;
  objective: string;
  triggerKind: 'manual' | 'event' | 'schedule';
  eventAppId?: string;
  eventType?: string;
  eventResource?: AutomationResourceRef;
  scheduleCron?: string;
  scheduleTimezone?: string;
  actorMode: 'fixed' | 'automatic';
  fixedAgentId?: string;
  eligibleAgentIds: string[];
  id?: string;
  executionMode: 'observe' | 'execute';
  actions: AutomationActionInput[];
  inputs: Record<string, unknown>;
  resources: AutomationResourceRef[];
  dataFlow: AutomationDataFlow;
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  limits: AutomationLimit[];
  enabled: boolean;
}

export interface AutomationDefinitionUpdateInput {
  id: string;
  ownerAccountId: string;
  expectedUpdatedAt: Date;
  objective: string;
  triggerKind: 'manual' | 'event' | 'schedule';
  eventAppId?: string;
  eventType?: string;
  eventResource?: AutomationResourceRef;
  scheduleCron?: string;
  scheduleTimezone?: string;
  actorMode: 'fixed' | 'automatic';
  fixedAgentId?: string;
  eligibleAgentIds: string[];
  resources: AutomationResourceRef[];
  dataFlow: AutomationDataFlow;
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  limits: AutomationLimit[];
  enabled: boolean;
  authorizations: readonly AutomationAuthorizationInput[];
}

function toAction(row: ActionRow) {
  return {
    id: row.id,
    position: row.position,
    resource: {
      appId: row.resourceAppId,
      effectiveAccountId: row.effectiveAccountId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
    },
    tool: row.tool,
    input: row.input,
    limits: row.limits,
  };
}

async function actionsFor(executor: Executor, automationIds: string[]) {
  if (automationIds.length === 0) return new Map<string, ReturnType<typeof toAction>[]>();
  const rows = await executor.select().from(automationActions)
    .where(inArray(automationActions.automationId, automationIds))
    .orderBy(automationActions.automationId, automationActions.position);
  const byAutomation = new Map<string, ReturnType<typeof toAction>[]>();
  for (const row of rows) {
    const current = byAutomation.get(row.automationId) ?? [];
    current.push(toAction(row));
    byAutomation.set(row.automationId, current);
  }
  return byAutomation;
}

async function assignmentsFor(executor: Executor, automationIds: string[]) {
  if (automationIds.length === 0) return new Map<string, string[]>();
  const rows = await executor
    .select()
    .from(automationActorAssignments)
    .where(inArray(automationActorAssignments.automationId, automationIds))
    .orderBy(automationActorAssignments.priority, automationActorAssignments.agentId);
  const byAutomation = new Map<string, string[]>();
  for (const row of rows) {
    const current = byAutomation.get(row.automationId) ?? [];
    current.push(row.agentId);
    byAutomation.set(row.automationId, current);
  }
  return byAutomation;
}

function toDefinition(
  row: DefinitionRow,
  eligibleAgentIds: string[],
  actions: ReturnType<typeof toAction>[],
) {
  return {
    id: row.id,
    ownerAccountId: row.ownerAccountId,
    objective: row.objective,
    trigger: row.triggerKind === 'schedule'
      ? { type: 'schedule' as const, cron: row.scheduleCron, timezone: row.scheduleTimezone }
      : row.triggerKind === 'event'
        ? { type: 'event' as const, appId: row.eventAppId, eventType: row.eventType, resource: row.eventResource }
        : { type: 'manual' as const },
    actorSelection: row.actorMode === 'fixed'
      ? { mode: 'fixed' as const, agentId: row.fixedAgentId }
      : { mode: 'automatic' as const, eligibleAgentIds },
    executionMode: row.executionMode,
    actions,
    inputs: row.inputs,
    resources: row.resources,
    dataFlow: row.dataFlow,
    maximumAutonomy: row.maximumAutonomy,
    limits: row.limits,
    enabled: row.enabled,
    legacyTriggerId: row.legacyTriggerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type AutomationDefinitionRecord = ReturnType<typeof toDefinition>;

async function hydrateDefinitions(
  db: Executor,
  rows: DefinitionRow[],
): Promise<AutomationDefinitionRecord[]> {
  const ids = rows.map((row) => row.id);
  const [assignments, actions] = await Promise.all([
    assignmentsFor(db, ids),
    actionsFor(db, ids),
  ]);
  return rows.map((row) => toDefinition(
    row,
    assignments.get(row.id) ?? [],
    actions.get(row.id) ?? [],
  ));
}

export async function listAutomationDefinitions(db: Executor, ownerAccountId: string) {
  const rows = await db.select().from(automationDefinitions)
    .where(eq(automationDefinitions.ownerAccountId, ownerAccountId))
    .orderBy(desc(automationDefinitions.createdAt));
  return hydrateDefinitions(db, rows);
}

export async function findAutomationDefinition(db: Executor, id: string, ownerAccountId: string) {
  const [row] = await db.select().from(automationDefinitions)
    .where(and(eq(automationDefinitions.id, id), eq(automationDefinitions.ownerAccountId, ownerAccountId)))
    .limit(1);
  if (!row) return null;
  const [assignments, actions] = await Promise.all([
    assignmentsFor(db, [id]),
    actionsFor(db, [id]),
  ]);
  return toDefinition(row, assignments.get(id) ?? [], actions.get(id) ?? []);
}

/** Scheduler-only lookup; ownership is preserved on the returned definition. */
export async function findAutomationDefinitionById(db: Executor, id: string) {
  const [row] = await db.select().from(automationDefinitions)
    .where(eq(automationDefinitions.id, id))
    .limit(1);
  if (!row) return null;
  return (await hydrateDefinitions(db, [row]))[0] ?? null;
}

/** Normalized schedules only. Legacy definitions continue through trigger rows. */
export async function listSchedulableAutomationDefinitions(db: Executor) {
  const rows = await db.select().from(automationDefinitions).where(and(
    eq(automationDefinitions.triggerKind, 'schedule'),
    eq(automationDefinitions.enabled, true),
    isNull(automationDefinitions.legacyTriggerId),
  )).orderBy(automationDefinitions.id);
  return hydrateDefinitions(db, rows);
}

export async function listSchedulableAutomationVersions(db: Executor) {
  return db.select({
    id: automationDefinitions.id,
    updatedAt: automationDefinitions.updatedAt,
  }).from(automationDefinitions).where(and(
    eq(automationDefinitions.triggerKind, 'schedule'),
    eq(automationDefinitions.enabled, true),
    isNull(automationDefinitions.legacyTriggerId),
  )).orderBy(automationDefinitions.id);
}

export async function createAutomationDefinition(db: ApiDatabase, input: AutomationDefinitionInput) {
  return db.transaction(async (transaction) => {
    const [row] = await transaction.insert(automationDefinitions).values({
      id: input.id,
      ownerAccountId: input.ownerAccountId,
      objective: input.objective,
      triggerKind: input.triggerKind,
      eventAppId: input.eventAppId,
      eventType: input.eventType,
      eventResource: input.eventResource,
      scheduleCron: input.scheduleCron,
      scheduleTimezone: input.scheduleTimezone,
      actorMode: input.actorMode,
      fixedAgentId: input.fixedAgentId,
      executionMode: input.executionMode,
      inputs: input.inputs,
      resources: input.resources,
      dataFlow: input.dataFlow,
      maximumAutonomy: input.maximumAutonomy,
      limits: input.limits,
      enabled: input.enabled,
    }).returning();
    if (!row) throw new Error('Automation definition insert returned no row');
    const assigned = input.actorMode === 'fixed' && input.fixedAgentId
      ? [input.fixedAgentId]
      : input.eligibleAgentIds;
    if (assigned.length > 0) {
      await transaction.insert(automationActorAssignments).values(
        assigned.map((agentId, priority) => ({ automationId: row.id, agentId, priority })),
      );
    }
    const actionRows = input.actions.length === 0
      ? []
      : await transaction.insert(automationActions).values(
        input.actions.map((action, position) => ({
          id: action.id,
          automationId: row.id,
          position,
          resourceAppId: action.resource.appId,
          effectiveAccountId: action.resource.effectiveAccountId,
          resourceType: action.resource.resourceType,
          resourceId: action.resource.resourceId,
          tool: action.tool,
          input: action.input,
          limits: action.limits,
        })),
      ).returning();
    return toDefinition(
      row,
      assigned,
      actionRows.sort((left, right) => left.position - right.position).map(toAction),
    );
  });
}

export async function setAutomationEnabled(
  db: Executor,
  id: string,
  ownerAccountId: string,
  enabled: boolean,
  expectedUpdatedAt?: Date,
) {
  const ownedDefinition = and(
    eq(automationDefinitions.id, id),
    eq(automationDefinitions.ownerAccountId, ownerAccountId),
  );
  const [row] = await db.update(automationDefinitions)
    .set({ enabled })
    .where(expectedUpdatedAt
      ? and(ownedDefinition, eq(automationDefinitions.updatedAt, expectedUpdatedAt))
      : ownedDefinition)
    .returning();
  if (!row) return null;
  const [assignments, actions] = await Promise.all([
    assignmentsFor(db, [id]),
    actionsFor(db, [id]),
  ]);
  return toDefinition(row, assignments.get(id) ?? [], actions.get(id) ?? []);
}

/**
 * Replace the editable definition fields and actor assignment order together.
 * Exact actions keep their ids so run history and Oxy authorization correlation
 * remain stable. The timestamp predicate prevents a stale editor from silently
 * overwriting a concurrent change.
 */
export async function updateAutomationDefinition(
  db: ApiDatabase,
  input: AutomationDefinitionUpdateInput,
) {
  return db.transaction(async (transaction) => {
    const [row] = await transaction.update(automationDefinitions).set({
      objective: input.objective,
      triggerKind: input.triggerKind,
      eventAppId: input.eventAppId ?? null,
      eventType: input.eventType ?? null,
      eventResource: input.eventResource ?? null,
      scheduleCron: input.scheduleCron ?? null,
      scheduleTimezone: input.scheduleTimezone ?? null,
      actorMode: input.actorMode,
      fixedAgentId: input.fixedAgentId ?? null,
      resources: input.resources,
      dataFlow: input.dataFlow,
      maximumAutonomy: input.maximumAutonomy,
      limits: input.limits,
      enabled: input.enabled,
    }).where(and(
      eq(automationDefinitions.id, input.id),
      eq(automationDefinitions.ownerAccountId, input.ownerAccountId),
      eq(automationDefinitions.updatedAt, input.expectedUpdatedAt),
    )).returning();
    if (!row) return null;

    const assigned = input.actorMode === 'fixed' && input.fixedAgentId
      ? [input.fixedAgentId]
      : input.eligibleAgentIds;
    await transaction.delete(automationActorAssignments)
      .where(eq(automationActorAssignments.automationId, row.id));
    if (assigned.length > 0) {
      await transaction.insert(automationActorAssignments).values(
        assigned.map((agentId, priority) => ({ automationId: row.id, agentId, priority })),
      );
    }
    await replaceAutomationActionAuthorizations(transaction, row.id, input.authorizations);
    const actions = await actionsFor(transaction, [row.id]);
    return toDefinition(row, assigned, actions.get(row.id) ?? []);
  });
}

/** Keep the transitional trigger scheduler and the structured control plane in sync. */
export async function upsertLegacyTriggerAutomation(input: {
  db: ApiDatabase;
  legacyTriggerId: string;
  ownerAccountId: string;
  objective: string;
  triggerKind: 'event' | 'schedule';
  eventAppId?: string;
  eventType?: string;
  scheduleCron?: string;
  scheduleTimezone?: string;
  fixedAgentId?: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
}) {
  return input.db.transaction(async (transaction) => {
    const [row] = await transaction.insert(automationDefinitions).values({
      id: `legacy-trigger-${input.legacyTriggerId}`,
      ownerAccountId: input.ownerAccountId,
      objective: input.objective,
      triggerKind: input.triggerKind,
      eventAppId: input.eventAppId,
      eventType: input.eventType,
      scheduleCron: input.scheduleCron,
      scheduleTimezone: input.scheduleTimezone,
      actorMode: input.fixedAgentId ? 'fixed' : 'automatic',
      fixedAgentId: input.fixedAgentId,
      executionMode: 'execute',
      inputs: input.inputs,
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: input.enabled,
      legacyTriggerId: input.legacyTriggerId,
    }).onConflictDoUpdate({
      target: automationDefinitions.legacyTriggerId,
      set: {
        objective: input.objective,
        triggerKind: input.triggerKind,
        eventAppId: input.eventAppId ?? null,
        eventType: input.eventType ?? null,
        scheduleCron: input.scheduleCron ?? null,
        scheduleTimezone: input.scheduleTimezone ?? null,
        actorMode: input.fixedAgentId ? 'fixed' : 'automatic',
        fixedAgentId: input.fixedAgentId ?? null,
        executionMode: 'execute',
        inputs: input.inputs,
        enabled: input.enabled,
      },
    }).returning();
    if (!row) throw new Error('Legacy automation upsert returned no row');
    await transaction.delete(automationActorAssignments)
      .where(eq(automationActorAssignments.automationId, row.id));
    if (input.fixedAgentId) {
      await transaction.insert(automationActorAssignments).values({
        automationId: row.id,
        agentId: input.fixedAgentId,
        priority: 0,
      });
    }
    return toDefinition(row, input.fixedAgentId ? [input.fixedAgentId] : [], []);
  });
}

export async function disableLegacyTriggerAutomation(db: Executor, legacyTriggerId: string): Promise<void> {
  await db.update(automationDefinitions).set({ enabled: false })
    .where(eq(automationDefinitions.legacyTriggerId, legacyTriggerId));
}

export async function beginLegacyTriggerAutomationRun(input: {
  db: Executor;
  legacyTriggerId: string;
  executionId: string;
  requesterAccountId: string;
  selectedAgentId?: string;
  selectedActorAccountId: string;
  manual: boolean;
}): Promise<boolean> {
  const [definition] = await input.db.select().from(automationDefinitions)
    .where(eq(automationDefinitions.legacyTriggerId, input.legacyTriggerId)).limit(1);
  if (!definition) return false;
  const inserted = await input.db.insert(automationRuns).values({
    id: input.executionId,
    automationId: definition.id,
    requesterAccountId: input.requesterAccountId,
    selectedActorType: input.selectedAgentId ? 'agent' : 'alia',
    selectedAgentId: input.selectedAgentId,
    idempotencyKey: `${definition.id}:${input.executionId}`,
    status: 'running',
    policyDecision: {
      allowed: true,
      reason: input.manual ? 'direct_user_request' : 'structured_schedule',
    },
    startedAt: new Date(),
  }).onConflictDoNothing({ target: automationRuns.idempotencyKey }).returning({ id: automationRuns.id });
  if (inserted.length === 0) return false;
  await input.db.insert(automationSteps).values({
    runId: input.executionId,
    position: 0,
    actorType: input.selectedAgentId ? 'agent' : 'alia',
    actorAccountId: input.selectedActorAccountId,
    resource: {
      appId: 'alia',
      effectiveAccountId: input.requesterAccountId,
      resourceType: 'automation',
      resourceId: definition.id,
    },
    tool: 'trigger.run',
    input: { legacyTriggerId: input.legacyTriggerId },
    status: 'running',
    policyDecision: { allowed: true, reason: input.manual ? 'direct_user_request' : 'structured_schedule' },
    idempotencyKey: `${input.executionId}:trigger.run`,
    startedAt: new Date(),
  });
  return true;
}

export async function listAutomationRuns(db: Executor, ownerAccountId: string, automationId?: string) {
  const predicates = [eq(automationRuns.requesterAccountId, ownerAccountId)];
  if (automationId) predicates.push(eq(automationRuns.automationId, automationId));
  return db.select().from(automationRuns).where(and(...predicates)).orderBy(desc(automationRuns.startedAt)).limit(200);
}

export async function listAutomationRunSteps(db: Executor, runId: string) {
  return db.select().from(automationSteps)
    .where(eq(automationSteps.runId, runId))
    .orderBy(automationSteps.position);
}

export interface NormalizedAutomationEventInput {
  eventId: string;
  appId: string;
  accountId: string;
  resource: AutomationResourceRef;
  eventType: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export async function claimAutomationEvent(
  db: Executor,
  event: NormalizedAutomationEventInput,
): Promise<boolean> {
  const inserted = await db.insert(automationEvents).values({
    ...event,
    status: 'received',
  }).onConflictDoNothing({
    target: [automationEvents.appId, automationEvents.eventId],
  }).returning({ id: automationEvents.id });
  return inserted.length === 1;
}

export async function markAutomationEventStatus(
  db: Executor,
  appId: string,
  eventId: string,
  status: 'matched' | 'processed' | 'failed',
): Promise<void> {
  await db.update(automationEvents).set({ status })
    .where(and(eq(automationEvents.appId, appId), eq(automationEvents.eventId, eventId)));
}

function sameResource(left: AutomationResourceRef, right: AutomationResourceRef): boolean {
  return left.appId === right.appId
    && left.effectiveAccountId === right.effectiveAccountId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId;
}

export async function matchingEventAutomations(
  db: Executor,
  event: NormalizedAutomationEventInput,
) {
  const rows = await db.select().from(automationDefinitions).where(and(
    eq(automationDefinitions.ownerAccountId, event.accountId),
    eq(automationDefinitions.triggerKind, 'event'),
    eq(automationDefinitions.enabled, true),
    isNull(automationDefinitions.legacyTriggerId),
  )).orderBy(automationDefinitions.id);
  const matching = rows.filter((row) => (
    (row.eventAppId === null || row.eventAppId === '*' || row.eventAppId === event.appId)
    && (row.eventType === '*' || row.eventType === event.eventType)
    && (row.eventResource === null || sameResource(row.eventResource, event.resource))
    && (
      row.dataFlow.sources.length === 0
      || row.dataFlow.sources.some((source) => sameResource(source, event.resource))
    )
  ));
  const ids = matching.map((row) => row.id);
  const [assignments, actions] = await Promise.all([
    assignmentsFor(db, ids),
    actionsFor(db, ids),
  ]);
  return matching.map((row) => toDefinition(
    row,
    assignments.get(row.id) ?? [],
    actions.get(row.id) ?? [],
  ));
}

export interface AutomationRunStageInput {
  stage: number;
  selectedAgentId: string;
  selectedActorAccountId: string;
  resource: AutomationResourceRef;
  taskInput: Record<string, unknown>;
  actions: Array<{
    id: string;
    resource: AutomationResourceRef;
    tool: string;
    input: Record<string, unknown>;
    limits: readonly AutomationActionLimit[];
  }>;
}

function runStepRows(
  runId: string,
  stages: readonly AutomationRunStageInput[],
  status: 'planned' | 'observed',
) {
  let position = 0;
  return stages.flatMap((stage) => {
    const startedAt = status === 'observed' ? new Date() : undefined;
    const control = {
      runId,
      position: position++,
      stage: stage.stage,
      actorType: 'agent' as const,
      agentId: stage.selectedAgentId,
      actorAccountId: stage.selectedActorAccountId,
      resource: stage.resource,
      tool: status === 'observed' ? 'agent.select' : 'agent.run',
      input: stage.taskInput,
      status,
      policyDecision: {
        allowed: true,
        reason: status === 'observed'
          ? 'observation_mode_no_execution'
          : 'actor_selected_deterministically',
      },
      idempotencyKey: `${runId}:stage:${stage.stage}:${status === 'observed' ? 'agent.select' : 'agent.run'}`,
      ...(startedAt ? { startedAt, completedAt: startedAt } : {}),
    };
    return [
      control,
      ...stage.actions.map((action) => ({
        runId,
        automationActionId: action.id,
        position: position++,
        stage: stage.stage,
        actorType: 'agent' as const,
        agentId: stage.selectedAgentId,
        actorAccountId: stage.selectedActorAccountId,
        resource: action.resource,
        tool: action.tool,
        input: action.input,
        status,
        policyDecision: {
          allowed: true,
          reason: status === 'observed'
            ? 'observation_mode_no_execution'
            : 'declared_automation_action',
        },
        idempotencyKey: `${runId}:action:${action.id}`,
        ...(startedAt ? { startedAt, completedAt: startedAt } : {}),
      })),
    ];
  });
}

/** Insert one run plan. Callers use a transaction when session creation follows. */
export async function claimAutomationRunPlan(input: {
  db: Executor;
  runId: string;
  automationId: string;
  requesterAccountId: string;
  triggerEventId: string;
  stages: readonly AutomationRunStageInput[];
}): Promise<boolean> {
  const selectedAgentIds = [...new Set(input.stages.map((stage) => stage.selectedAgentId))];
  const inserted = await input.db.insert(automationRuns).values({
    id: input.runId,
    automationId: input.automationId,
    requesterAccountId: input.requesterAccountId,
    selectedActorType: 'agent',
    selectedAgentId: selectedAgentIds.length === 1 ? selectedAgentIds[0] : null,
    triggerEventId: input.triggerEventId,
    idempotencyKey: `${input.automationId}:${input.triggerEventId}`,
    status: 'planned',
    policyDecision: {
      allowed: true,
      reason: 'matched_structured_automation',
      selectedAgentIds,
    },
    startedAt: new Date(),
  }).onConflictDoNothing({ target: automationRuns.idempotencyKey }).returning({ id: automationRuns.id });
  if (inserted.length === 0) return false;
  await input.db.insert(automationSteps).values(runStepRows(input.runId, input.stages, 'planned'));
  return true;
}

/** Record the exact decision graph without creating a session or executing an effect. */
export async function createObservedAutomationRun(input: {
  db: ApiDatabase;
  automationId: string;
  requesterAccountId: string;
  triggerEventId: string;
  stages: readonly AutomationRunStageInput[];
}): Promise<boolean> {
  const runId = uuidv7();
  return input.db.transaction(async (transaction) => {
    const now = new Date();
    const selectedAgentIds = [...new Set(input.stages.map((stage) => stage.selectedAgentId))];
    const inserted = await transaction.insert(automationRuns).values({
      id: runId,
      automationId: input.automationId,
      requesterAccountId: input.requesterAccountId,
      selectedActorType: 'agent',
      selectedAgentId: selectedAgentIds.length === 1 ? selectedAgentIds[0] : null,
      triggerEventId: input.triggerEventId,
      idempotencyKey: `${input.automationId}:${input.triggerEventId}`,
      status: 'observed',
      policyDecision: { allowed: true, reason: 'observation_mode_no_execution', selectedAgentIds },
      startedAt: now,
      completedAt: now,
    }).onConflictDoNothing({ target: automationRuns.idempotencyKey }).returning({ id: automationRuns.id });
    if (inserted.length === 0) return false;
    await transaction.insert(automationSteps).values(runStepRows(runId, input.stages, 'observed'));
    return true;
  });
}

export interface AutomationAuthorizationInput {
  automationActionId: string;
  agentId: string;
  actorAccountId: string;
  oxyAuthorizationId: string;
  expiresAt: Date;
}

/** Replace an expired or revoked remote reference without retaining token history. */
export async function upsertAutomationActionAuthorizations(
  db: Executor,
  authorizations: readonly AutomationAuthorizationInput[],
): Promise<void> {
  if (authorizations.length === 0) return;
  for (const authorization of authorizations) {
    await db.insert(automationActionAuthorizations).values(authorization).onConflictDoUpdate({
      target: [
        automationActionAuthorizations.automationActionId,
        automationActionAuthorizations.agentId,
      ],
      set: {
        actorAccountId: authorization.actorAccountId,
        oxyAuthorizationId: authorization.oxyAuthorizationId,
        expiresAt: authorization.expiresAt,
        revokedAt: null,
      },
    });
  }
}

/**
 * Retire every locally active reference before installing the freshly
 * revalidated set. Remote ids are revoked by the caller before this transaction;
 * keeping the old rows makes incomplete external cleanup observable.
 */
export async function replaceAutomationActionAuthorizations(
  db: Executor,
  automationId: string,
  authorizations: readonly AutomationAuthorizationInput[],
): Promise<void> {
  const current = await listActiveAutomationAuthorizations(db, automationId);
  if (current.length > 0) {
    await markAutomationAuthorizationsRevoked(
      db,
      current.map((authorization) => authorization.oxyAuthorizationId),
    );
  }
  await upsertAutomationActionAuthorizations(db, authorizations);
}

export async function listActiveAutomationAuthorizations(
  db: Executor,
  automationId: string,
  agentId?: string,
) {
  const predicates = [
    eq(automationActions.automationId, automationId),
    isNull(automationActionAuthorizations.revokedAt),
    gt(automationActionAuthorizations.expiresAt, new Date()),
  ];
  if (agentId) predicates.push(eq(automationActionAuthorizations.agentId, agentId));
  return db.select({
    automationActionId: automationActionAuthorizations.automationActionId,
    agentId: automationActionAuthorizations.agentId,
    actorAccountId: automationActionAuthorizations.actorAccountId,
    oxyAuthorizationId: automationActionAuthorizations.oxyAuthorizationId,
    expiresAt: automationActionAuthorizations.expiresAt,
  }).from(automationActionAuthorizations)
    .innerJoin(automationActions, eq(
      automationActions.id,
      automationActionAuthorizations.automationActionId,
    ))
    .where(and(...predicates))
    .orderBy(asc(automationActions.position), automationActionAuthorizations.agentId);
}

export async function automationHasActiveAuthorizationCoverage(
  db: Executor,
  automationId: string,
  agentId: string,
  actionIds: readonly string[],
): Promise<boolean> {
  if (actionIds.length === 0) return false;
  const rows = await listActiveAutomationAuthorizations(db, automationId, agentId);
  const covered = new Set(rows.map((row) => row.automationActionId));
  return actionIds.every((actionId) => covered.has(actionId));
}

export async function markAutomationAuthorizationsRevoked(
  db: Executor,
  oxyAuthorizationIds: readonly string[],
): Promise<void> {
  if (oxyAuthorizationIds.length === 0) return;
  await db.update(automationActionAuthorizations)
    .set({ revokedAt: new Date() })
    .where(inArray(automationActionAuthorizations.oxyAuthorizationId, [...oxyAuthorizationIds]));
}

/** Exact Oxy authority and step correlation for one queued structured run. */
export async function listAutomationExecutionAuthorizationsForRun(
  db: Executor,
  runId: string,
  agentId: string,
  stage?: number,
) {
  const predicates = [eq(automationSteps.runId, runId)];
  if (stage !== undefined) {
    predicates.push(eq(automationSteps.stage, stage), eq(automationSteps.agentId, agentId));
  }
  return db.select({
    stepId: automationSteps.id,
    automationActionId: automationSteps.automationActionId,
    resourceAppId: automationActions.resourceAppId,
    effectiveAccountId: automationActions.effectiveAccountId,
    resourceType: automationActions.resourceType,
    resourceId: automationActions.resourceId,
    tool: automationActions.tool,
    oxyAuthorizationId: automationActionAuthorizations.oxyAuthorizationId,
  }).from(automationSteps)
    .innerJoin(automationActions, eq(automationActions.id, automationSteps.automationActionId))
    .innerJoin(automationActionAuthorizations, and(
      eq(automationActionAuthorizations.automationActionId, automationActions.id),
      eq(automationActionAuthorizations.agentId, agentId),
      isNull(automationActionAuthorizations.revokedAt),
      gt(automationActionAuthorizations.expiresAt, new Date()),
    ))
    .where(and(...predicates))
    .orderBy(automationSteps.position);
}

export async function markAutomationActionStep(
  db: Executor,
  stepId: string,
  status: 'running' | 'succeeded' | 'failed',
  auditEventId?: string,
): Promise<void> {
  const now = new Date();
  await db.update(automationSteps).set({
    status,
    ...(auditEventId ? { auditEventId } : {}),
    ...(status === 'running' ? { startedAt: now } : { completedAt: now }),
  }).where(eq(automationSteps.id, stepId));
}

export async function markAutomationRunForSession(
  db: ApiDatabase,
  sessionId: string,
  status: 'running' | 'succeeded' | 'failed' | 'cancelled',
): Promise<void> {
  const [binding] = await db.select({
    runId: agentSessions.automationRunId,
    stage: agentSessions.automationStage,
  }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (binding?.runId !== null && binding?.runId !== undefined
    && binding.stage !== null && binding.stage !== undefined) {
    const runId = binding.runId;
    const stage = binding.stage;
    await db.transaction(async (transaction) => {
      const now = new Date();
      const stagePredicate = and(
        eq(automationSteps.runId, runId),
        eq(automationSteps.stage, stage),
      );
      if (status === 'running') {
        await transaction.update(automationRuns).set({ status: 'running' })
          .where(eq(automationRuns.id, runId));
        await transaction.update(automationSteps).set({ status: 'running', startedAt: now })
          .where(and(stagePredicate, eq(automationSteps.tool, 'agent.run')));
        return;
      }

      if (status === 'failed' || status === 'cancelled') {
        await transaction.update(automationRuns).set({ status, completedAt: now })
          .where(eq(automationRuns.id, runId));
        await transaction.update(automationSteps).set({ status, completedAt: now })
          .where(and(stagePredicate, inArray(automationSteps.status, ['planned', 'running'])));
        await transaction.update(automationSteps).set({ status: 'cancelled', completedAt: now })
          .where(and(
            eq(automationSteps.runId, runId),
            gt(automationSteps.stage, stage),
            eq(automationSteps.status, 'planned'),
          ));
        return;
      }

      const actionRows = await transaction.select({ status: automationSteps.status })
        .from(automationSteps)
        .where(and(stagePredicate, isNotNull(automationSteps.automationActionId)));
      const stageSucceeded = actionRows.length > 0
        && actionRows.every((row) => row.status === 'succeeded');
      if (!stageSucceeded) {
        await transaction.update(automationRuns).set({ status: 'failed', completedAt: now })
          .where(eq(automationRuns.id, runId));
        await transaction.update(automationSteps).set({ status: 'failed', completedAt: now })
          .where(and(stagePredicate, inArray(automationSteps.status, ['planned', 'running'])));
        await transaction.update(automationSteps).set({ status: 'cancelled', completedAt: now })
          .where(and(
            eq(automationSteps.runId, runId),
            gt(automationSteps.stage, stage),
            eq(automationSteps.status, 'planned'),
          ));
        return;
      }

      await transaction.update(automationSteps).set({ status: 'succeeded', completedAt: now })
        .where(and(stagePredicate, eq(automationSteps.tool, 'agent.run')));
      const [nextStage] = await transaction.select({ id: automationSteps.id })
        .from(automationSteps)
        .where(and(
          eq(automationSteps.runId, runId),
          gt(automationSteps.stage, stage),
          eq(automationSteps.tool, 'agent.run'),
          eq(automationSteps.status, 'planned'),
        )).orderBy(automationSteps.stage).limit(1);
      await transaction.update(automationRuns).set(nextStage
        ? { status: 'running' }
        : { status: 'succeeded', completedAt: now })
        .where(eq(automationRuns.id, runId));
    });
    return;
  }

  // Legacy normalized runs used the session id as the run id. Keep pending
  // pre-migration jobs and transitional trigger executions readable.
  await Promise.all([
    db.update(automationRuns).set({
      status,
      ...(status === 'running' ? {} : { completedAt: new Date() }),
    }).where(eq(automationRuns.id, sessionId)),
    db.update(automationSteps).set({
      status,
      ...(status === 'running' ? { startedAt: new Date() } : { completedAt: new Date() }),
    }).where(and(eq(automationSteps.runId, sessionId), eq(automationSteps.tool, 'agent.run'))),
  ]);
}

export type AutomationRunProgress =
  | { kind: 'none' }
  | { kind: 'invalid'; runId: string }
  | { kind: 'terminal'; runId: string; status: 'succeeded' | 'failed' | 'cancelled' }
  | {
      kind: 'next';
      runId: string;
      stage: number;
      agentId: string;
      actorAccountId: string;
      ownerAccountId: string;
      taskInput: Record<string, unknown>;
    };

/** Read the next stage only after the runner has finalized the current stage. */
export async function automationRunProgressForSession(
  db: Executor,
  sessionId: string,
): Promise<AutomationRunProgress> {
  const [binding] = await db.select({
    runId: agentSessions.automationRunId,
    stage: agentSessions.automationStage,
  }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (binding?.runId === null || binding?.runId === undefined
    || binding.stage === null || binding.stage === undefined) return { kind: 'none' };
  const [run] = await db.select({
    status: automationRuns.status,
    ownerAccountId: automationRuns.requesterAccountId,
  }).from(automationRuns).where(eq(automationRuns.id, binding.runId)).limit(1);
  if (!run) return { kind: 'none' };
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
    return { kind: 'terminal', runId: binding.runId, status: run.status };
  }
  const [current] = await db.select({ status: automationSteps.status })
    .from(automationSteps).where(and(
      eq(automationSteps.runId, binding.runId),
      eq(automationSteps.stage, binding.stage),
      eq(automationSteps.tool, 'agent.run'),
    )).limit(1);
  if (current?.status !== 'succeeded') return { kind: 'invalid', runId: binding.runId };
  const [next] = await db.select({
    stage: automationSteps.stage,
    agentId: automationSteps.agentId,
    actorAccountId: automationSteps.actorAccountId,
    taskInput: automationSteps.input,
  }).from(automationSteps).where(and(
    eq(automationSteps.runId, binding.runId),
    gt(automationSteps.stage, binding.stage),
    eq(automationSteps.tool, 'agent.run'),
    eq(automationSteps.status, 'planned'),
  )).orderBy(automationSteps.stage).limit(1);
  if (!next || next.stage === null || next.agentId === null) {
    return { kind: 'invalid', runId: binding.runId };
  }
  return {
    kind: 'next',
    runId: binding.runId,
    stage: next.stage,
    agentId: next.agentId,
    actorAccountId: next.actorAccountId,
    ownerAccountId: run.ownerAccountId,
    taskInput: next.taskInput,
  };
}
