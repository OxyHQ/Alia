/** Structured autonomy: durable definitions, runs, steps and normalized events. */

import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

export const AUTOMATION_TRIGGER_KINDS = ['manual', 'event', 'schedule'] as const;
export const AUTOMATION_ACTOR_MODES = ['fixed', 'automatic'] as const;
export const AUTOMATION_AUTONOMY_LEVELS = ['read_only', 'draft', 'execute_on_request', 'autonomous'] as const;
export const AUTOMATION_RUN_STATUSES = ['planned', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const AUTOMATION_STEP_STATUSES = ['planned', 'running', 'succeeded', 'failed', 'denied', 'cancelled'] as const;
export const AUTOMATION_EVENT_STATUSES = ['received', 'matched', 'duplicate', 'processed', 'failed'] as const;

export interface AutomationResourceRef {
  appId: string;
  effectiveAccountId: string;
  resourceType: string;
  resourceId: string;
}

export interface AutomationLimit {
  key: string;
  value: string | number | boolean | string[];
}

export interface AutomationDataFlow {
  sources: AutomationResourceRef[];
  destinations: AutomationResourceRef[];
}

export const automationDefinitions = pgTable(
  'automation_definitions',
  {
    id: generatedId(),
    ownerAccountId: text().notNull(),
    objective: text().notNull(),
    triggerKind: text({ enum: AUTOMATION_TRIGGER_KINDS as unknown as [string, ...string[]] }).notNull(),
    eventAppId: text(),
    eventType: text(),
    eventResource: jsonb().$type<AutomationResourceRef>(),
    scheduleCron: text(),
    scheduleTimezone: text(),
    actorMode: text({ enum: AUTOMATION_ACTOR_MODES as unknown as [string, ...string[]] }).notNull(),
    fixedAgentId: text(),
    inputs: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    resources: jsonb().$type<AutomationResourceRef[]>().notNull().default([]),
    dataFlow: jsonb().$type<AutomationDataFlow>().notNull().default({ sources: [], destinations: [] }),
    maximumAutonomy: text({ enum: AUTOMATION_AUTONOMY_LEVELS as unknown as [string, ...string[]] }).notNull(),
    limits: jsonb().$type<AutomationLimit[]>().notNull().default([]),
    enabled: boolean().notNull().default(true),
    /** Transitional one-to-one link used while legacy triggers are backfilled. */
    legacyTriggerId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('automation_definitions_owner_idx').on(table.ownerAccountId),
    index('automation_definitions_event_idx').on(table.eventAppId, table.eventType),
    index('automation_definitions_schedule_idx').on(table.triggerKind, table.enabled),
    uniqueIndex('automation_definitions_legacy_trigger_key').on(table.legacyTriggerId),
    checkOneOf('automation_definitions_trigger_kind_check', table.triggerKind, AUTOMATION_TRIGGER_KINDS),
    checkOneOf('automation_definitions_actor_mode_check', table.actorMode, AUTOMATION_ACTOR_MODES),
    checkOneOf('automation_definitions_autonomy_check', table.maximumAutonomy, AUTOMATION_AUTONOMY_LEVELS),
  ],
);

export const automationActorAssignments = pgTable(
  'automation_actor_assignments',
  {
    id: generatedId(),
    automationId: text().notNull(),
    agentId: text().notNull(),
    priority: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('automation_actor_assignments_automation_agent_key').on(table.automationId, table.agentId),
    index('automation_actor_assignments_priority_idx').on(table.automationId, table.priority, table.agentId),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: generatedId(),
    automationId: text().notNull(),
    requesterAccountId: text().notNull(),
    selectedActorType: text({ enum: ['alia', 'agent'] as unknown as [string, ...string[]] }).notNull(),
    selectedAgentId: text(),
    triggerEventId: text(),
    idempotencyKey: text().notNull(),
    status: text({ enum: AUTOMATION_RUN_STATUSES as unknown as [string, ...string[]] }).notNull(),
    policyDecision: jsonb().$type<Record<string, unknown>>(),
    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('automation_runs_idempotency_key').on(table.idempotencyKey),
    index('automation_runs_automation_started_idx').on(table.automationId, table.startedAt.desc()),
    index('automation_runs_requester_idx').on(table.requesterAccountId, table.startedAt.desc()),
    checkOneOf('automation_runs_status_check', table.status, AUTOMATION_RUN_STATUSES),
  ],
);

export const automationSteps = pgTable(
  'automation_steps',
  {
    id: generatedId(),
    runId: text().notNull(),
    position: integer().notNull(),
    actorType: text({ enum: ['alia', 'agent'] as unknown as [string, ...string[]] }).notNull(),
    actorAccountId: text().notNull(),
    resource: jsonb().$type<AutomationResourceRef>().notNull(),
    tool: text().notNull(),
    input: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb().$type<Record<string, unknown>>(),
    status: text({ enum: AUTOMATION_STEP_STATUSES as unknown as [string, ...string[]] }).notNull(),
    policyDecision: jsonb().$type<Record<string, unknown>>(),
    auditEventId: text(),
    idempotencyKey: text().notNull(),
    startedAt: timestamptz(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('automation_steps_run_position_key').on(table.runId, table.position),
    uniqueIndex('automation_steps_run_idempotency_key').on(table.runId, table.idempotencyKey),
    index('automation_steps_run_status_idx').on(table.runId, table.status),
    checkOneOf('automation_steps_status_check', table.status, AUTOMATION_STEP_STATUSES),
  ],
);

export const automationEvents = pgTable(
  'automation_events',
  {
    id: generatedId(),
    eventId: text().notNull(),
    appId: text().notNull(),
    accountId: text().notNull(),
    resource: jsonb().$type<AutomationResourceRef>().notNull(),
    eventType: text().notNull(),
    occurredAt: timestamptz().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text({ enum: AUTOMATION_EVENT_STATUSES as unknown as [string, ...string[]] }).notNull(),
    receivedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('automation_events_app_event_key').on(table.appId, table.eventId),
    index('automation_events_match_idx').on(table.appId, table.accountId, table.eventType, table.status),
    checkOneOf('automation_events_status_check', table.status, AUTOMATION_EVENT_STATUSES),
  ],
);
