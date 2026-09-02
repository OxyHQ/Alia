/** Structured autonomy: durable definitions, runs, steps and normalized events. */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

export const AUTOMATION_TRIGGER_KINDS = ['manual', 'event', 'schedule'] as const;
export const AUTOMATION_ACTOR_MODES = ['fixed', 'automatic'] as const;
export const AUTOMATION_EXECUTION_MODES = ['observe', 'execute'] as const;
export const AUTOMATION_AUTONOMY_LEVELS = ['read_only', 'draft', 'execute_on_request', 'autonomous'] as const;
export const AUTOMATION_RUN_STATUSES = ['planned', 'running', 'observed', 'succeeded', 'failed', 'cancelled'] as const;
export const AUTOMATION_STEP_STATUSES = ['planned', 'running', 'observed', 'succeeded', 'failed', 'denied', 'cancelled'] as const;
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

/** Oxy policy limits are deliberately scalar and scoped to one exact action. */
export interface AutomationActionLimit {
  key: string;
  value: number | boolean;
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
    executionMode: text({ enum: AUTOMATION_EXECUTION_MODES as unknown as [string, ...string[]] })
      .$type<(typeof AUTOMATION_EXECUTION_MODES)[number]>()
      .notNull()
      .default('observe'),
    inputs: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    resources: jsonb().$type<AutomationResourceRef[]>().notNull().default([]),
    dataFlow: jsonb().$type<AutomationDataFlow>().notNull().default({ sources: [], destinations: [] }),
    maximumAutonomy: text({ enum: AUTOMATION_AUTONOMY_LEVELS as unknown as [string, ...string[]] })
      .$type<(typeof AUTOMATION_AUTONOMY_LEVELS)[number]>()
      .notNull(),
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
    checkOneOf('automation_definitions_execution_mode_check', table.executionMode, AUTOMATION_EXECUTION_MODES),
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

/** Exact Oxy effects a structured automation may attempt, in stable order. */
export const automationActions = pgTable(
  'automation_actions',
  {
    id: generatedId(),
    automationId: text().notNull().references(() => automationDefinitions.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    resourceAppId: text().notNull(),
    effectiveAccountId: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text().notNull(),
    tool: text().notNull(),
    input: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    limits: jsonb().$type<AutomationActionLimit[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('automation_actions_automation_position_key').on(table.automationId, table.position),
    uniqueIndex('automation_actions_exact_tool_key').on(
      table.automationId,
      table.resourceAppId,
      table.effectiveAccountId,
      table.resourceType,
      table.resourceId,
      table.tool,
    ),
    index('automation_actions_resource_idx').on(
      table.resourceAppId,
      table.effectiveAccountId,
      table.resourceType,
      table.resourceId,
    ),
    check('automation_actions_input_check', sql`jsonb_typeof(${table.input}) = 'object'`),
    check(
      'automation_actions_limits_check',
      sql`jsonb_typeof(${table.limits}) = 'array'
        and not jsonb_path_exists(${table.limits}, '$[*] ? (@.type() != "object" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists(${table.limits}, '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "key" && @.key != "value")')`,
    ),
  ],
);

/**
 * Durable Oxy authorization references. The bearer that created them is never
 * stored; Oxy remains the authority and re-evaluates every issued ticket.
 */
export const automationActionAuthorizations = pgTable(
  'automation_action_authorizations',
  {
    id: generatedId(),
    automationActionId: text().notNull().references(() => automationActions.id, { onDelete: 'cascade' }),
    agentId: text().notNull(),
    actorAccountId: text().notNull(),
    oxyAuthorizationId: text().notNull(),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('automation_action_authorizations_action_agent_key')
      .on(table.automationActionId, table.agentId),
    uniqueIndex('automation_action_authorizations_oxy_key').on(table.oxyAuthorizationId),
    index('automation_action_authorizations_agent_live_idx')
      .on(table.agentId, table.expiresAt, table.revokedAt),
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
    automationActionId: text().references(() => automationActions.id, { onDelete: 'set null' }),
    position: integer().notNull(),
    stage: integer(),
    actorType: text({ enum: ['alia', 'agent'] as unknown as [string, ...string[]] }).notNull(),
    agentId: text(),
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
    index('automation_steps_run_stage_idx').on(table.runId, table.stage, table.position),
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
