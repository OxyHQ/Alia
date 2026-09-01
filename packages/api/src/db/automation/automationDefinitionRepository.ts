import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import {
  automationActorAssignments,
  automationDefinitions,
  automationEvents,
  automationRuns,
  automationSteps,
  type AutomationDataFlow,
  type AutomationLimit,
  type AutomationResourceRef,
} from '../schema/agency';

type DefinitionRow = typeof automationDefinitions.$inferSelect;

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
  inputs: Record<string, unknown>;
  resources: AutomationResourceRef[];
  dataFlow: AutomationDataFlow;
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  limits: AutomationLimit[];
  enabled: boolean;
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

function toDefinition(row: DefinitionRow, eligibleAgentIds: string[]) {
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
  const assignments = await assignmentsFor(db, rows.map((row) => row.id));
  return rows.map((row) => toDefinition(row, assignments.get(row.id) ?? []));
}

export async function findAutomationDefinition(db: Executor, id: string, ownerAccountId: string) {
  const [row] = await db.select().from(automationDefinitions)
    .where(and(eq(automationDefinitions.id, id), eq(automationDefinitions.ownerAccountId, ownerAccountId)))
    .limit(1);
  if (!row) return null;
  const assignments = await assignmentsFor(db, [id]);
  return toDefinition(row, assignments.get(id) ?? []);
}

export async function createAutomationDefinition(db: ApiDatabase, input: AutomationDefinitionInput) {
  return db.transaction(async (transaction) => {
    const [row] = await transaction.insert(automationDefinitions).values({
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
    return toDefinition(row, assigned);
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
  const assignments = await assignmentsFor(db, [id]);
  return toDefinition(row, assignments.get(id) ?? []);
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
    return toDefinition(row, input.fixedAgentId ? [input.fixedAgentId] : []);
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
  const assignments = await assignmentsFor(db, matching.map((row) => row.id));
  return matching.map((row) => ({ row, eligibleAgentIds: assignments.get(row.id) ?? [] }));
}

export async function createAutomationRunForSession(input: {
  db: Executor;
  sessionId: string;
  automationId: string;
  requesterAccountId: string;
  selectedAgentId: string;
  selectedActorAccountId: string;
  triggerEventId: string;
  resource: AutomationResourceRef;
  objective: string;
}): Promise<boolean> {
  const inserted = await input.db.insert(automationRuns).values({
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
  await input.db.insert(automationSteps).values({
    runId: input.sessionId,
    position: 0,
    actorType: 'agent',
    actorAccountId: input.selectedActorAccountId,
    resource: input.resource,
    tool: 'agent.run',
    input: { objective: input.objective, triggerEventId: input.triggerEventId },
    status: 'planned',
    policyDecision: { allowed: true, reason: 'actor_selected_deterministically' },
    idempotencyKey: `${input.sessionId}:agent.run`,
  });
  return true;
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
