import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAutomationDefinitions(db: Executor, ownerAccountId: string) {
  const rows = await db.select().from(automationDefinitions)
    .where(eq(automationDefinitions.ownerAccountId, ownerAccountId))
    .orderBy(desc(automationDefinitions.createdAt));
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
) {
  const [row] = await db.update(automationDefinitions)
    .set({ enabled })
    .where(and(eq(automationDefinitions.id, id), eq(automationDefinitions.ownerAccountId, ownerAccountId)))
    .returning();
  if (!row) return null;
  const [assignments, actions] = await Promise.all([
    assignmentsFor(db, [id]),
    actionsFor(db, [id]),
  ]);
  return toDefinition(row, assignments.get(id) ?? [], actions.get(id) ?? []);
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
  return matching.map((row) => ({
    row,
    actions: actions.get(row.id) ?? [],
    eligibleAgentIds: assignments.get(row.id) ?? [],
  }));
}

export async function createAutomationRunForSession(input: {
  db: ApiDatabase;
  sessionId: string;
  automationId: string;
  requesterAccountId: string;
  selectedAgentId: string;
  selectedActorAccountId: string;
  triggerEventId: string;
  resource: AutomationResourceRef;
  objective: string;
  actions: ReturnType<typeof toAction>[];
}): Promise<boolean> {
  return input.db.transaction(async (transaction) => {
    const inserted = await transaction.insert(automationRuns).values({
      id: input.sessionId,
      automationId: input.automationId,
      requesterAccountId: input.requesterAccountId,
      selectedActorType: 'agent',
      selectedAgentId: input.selectedAgentId,
      triggerEventId: input.triggerEventId,
      idempotencyKey: `${input.automationId}:${input.triggerEventId}`,
      status: 'planned',
      policyDecision: { allowed: true, reason: 'matched_structured_automation' },
      startedAt: new Date(),
    }).onConflictDoNothing({ target: automationRuns.idempotencyKey }).returning({ id: automationRuns.id });
    if (inserted.length === 0) return false;
    await transaction.insert(automationSteps).values([
      {
        runId: input.sessionId,
        position: 0,
        actorType: 'agent' as const,
        actorAccountId: input.selectedActorAccountId,
        resource: input.resource,
        tool: 'agent.run',
        input: { objective: input.objective, triggerEventId: input.triggerEventId },
        status: 'planned' as const,
        policyDecision: { allowed: true, reason: 'actor_selected_deterministically' },
        idempotencyKey: `${input.sessionId}:agent.run`,
      },
      ...input.actions.map((action, index) => ({
        runId: input.sessionId,
        automationActionId: action.id,
        position: index + 1,
        actorType: 'agent' as const,
        actorAccountId: input.selectedActorAccountId,
        resource: action.resource,
        tool: action.tool,
        input: action.input,
        status: 'planned' as const,
        policyDecision: { allowed: true, reason: 'declared_automation_action' },
        idempotencyKey: `${input.sessionId}:action:${action.id}`,
      })),
    ]);
    return true;
  });
}

/** Record the exact decision graph without creating a session or executing an effect. */
export async function createObservedAutomationRun(input: {
  db: ApiDatabase;
  automationId: string;
  requesterAccountId: string;
  selectedAgentId: string;
  selectedActorAccountId: string;
  triggerEventId: string;
  resource: AutomationResourceRef;
  objective: string;
  actions: ReturnType<typeof toAction>[];
}): Promise<boolean> {
  const runId = uuidv7();
  return input.db.transaction(async (transaction) => {
    const now = new Date();
    const inserted = await transaction.insert(automationRuns).values({
      id: runId,
      automationId: input.automationId,
      requesterAccountId: input.requesterAccountId,
      selectedActorType: 'agent',
      selectedAgentId: input.selectedAgentId,
      triggerEventId: input.triggerEventId,
      idempotencyKey: `${input.automationId}:${input.triggerEventId}`,
      status: 'observed',
      policyDecision: { allowed: true, reason: 'observation_mode_no_execution' },
      startedAt: now,
      completedAt: now,
    }).onConflictDoNothing({ target: automationRuns.idempotencyKey }).returning({ id: automationRuns.id });
    if (inserted.length === 0) return false;
    await transaction.insert(automationSteps).values([
      {
        runId,
        position: 0,
        actorType: 'agent' as const,
        actorAccountId: input.selectedActorAccountId,
        resource: input.resource,
        tool: 'agent.select',
        input: { objective: input.objective, triggerEventId: input.triggerEventId },
        status: 'observed' as const,
        policyDecision: { allowed: true, reason: 'actor_selected_deterministically' },
        idempotencyKey: `${runId}:agent.select`,
        startedAt: now,
        completedAt: now,
      },
      ...input.actions.map((action, index) => ({
        runId,
        automationActionId: action.id,
        position: index + 1,
        actorType: 'agent' as const,
        actorAccountId: input.selectedActorAccountId,
        resource: action.resource,
        tool: action.tool,
        input: action.input,
        status: 'observed' as const,
        policyDecision: { allowed: true, reason: 'observation_mode_no_execution' },
        idempotencyKey: `${runId}:action:${action.id}`,
        startedAt: now,
        completedAt: now,
      })),
    ]);
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
) {
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
    .where(eq(automationSteps.runId, runId))
    .orderBy(automationSteps.position);
}

export async function markAutomationActionStep(
  db: Executor,
  stepId: string,
  status: 'running' | 'succeeded' | 'failed',
): Promise<void> {
  const now = new Date();
  await db.update(automationSteps).set({
    status,
    ...(status === 'running' ? { startedAt: now } : { completedAt: now }),
  }).where(eq(automationSteps.id, stepId));
}

export async function markAutomationRunForSession(
  db: Executor,
  sessionId: string,
  status: 'running' | 'succeeded' | 'failed' | 'cancelled',
): Promise<void> {
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
