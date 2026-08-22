/**
 * Automation: triggers that fire, workflows that run, and the record of each.
 *
 * ## `triggers` is a discriminated union, and it does NOT get a discriminant CHECK
 *
 * `type` selects which of three configuration groups applies — `schedule_*`,
 * `webhook_*`, `integration_event_*` — and the flattened columns make the shape
 * visible in a way the Mongoose sub-documents did not. It is tempting to add
 * `type = 'schedule'` ⟺ `schedule_type is not null` and be done. That CHECK
 * would be WRONG, and not merely risky:
 *
 *  - **`agent_heartbeat` triggers also carry a `schedule`.** `lib/trigger-engine.ts`
 *    schedules `type IN ('schedule', 'agent_heartbeat')` and reads
 *    `trigger.schedule` for both, and `:796` creates heartbeat triggers directly.
 *    So the discriminant is not one-to-one with the group, and the obvious
 *    constraint would reject rows the engine creates itself.
 *  - Mongoose enforced no cross-field rule at all, so production may hold any
 *    combination — the `auth_health_metrics.method` reasoning applied to a
 *    relationship rather than to a value.
 *
 * The correct constraint is `schedule` present ⟹ `type IN ('schedule',
 * 'agent_heartbeat')`, which is still a tightening nothing has validated. It is
 * an item for the backfill audit, recorded here rather than guessed at now.
 *
 * ## `webhook_token` is a LOOKUP KEY and stays in the clear
 *
 * `lib/trigger-engine.ts:701` finds a trigger by `'webhook.token'`, and the
 * public URL is `/triggers/webhook/<token>`. Same structural reason as
 * `bots.webhook_secret`: an encrypted column cannot be matched by equality,
 * because the codec's IV is random. `webhook_secret` beside it is an optional
 * HMAC verification key, read after the row is found — neither was encrypted in
 * Mongo and neither is encrypted here, which is the faithful port. Both are
 * credentials: never log them, never select them into a response.
 */

import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

export const TRIGGER_TYPES = ['schedule', 'webhook', 'integration_event', 'agent_heartbeat'] as const;
export type TriggerTypeValue = (typeof TRIGGER_TYPES)[number];

export const TRIGGER_SCHEDULE_TYPES = ['cron', 'daily', 'interval'] as const;
export type TriggerScheduleType = (typeof TRIGGER_SCHEDULE_TYPES)[number];

export const TRIGGER_LAST_STATUSES = ['success', 'failed', 'running'] as const;
export type TriggerLastStatus = (typeof TRIGGER_LAST_STATUSES)[number];

/**
 * The execution's own view of what fired it. A superset of `TRIGGER_TYPES` —
 * `manual` is not a trigger KIND, it is a way an existing trigger can be run.
 */
export const TRIGGER_EXECUTION_TRIGGER_TYPES = [...TRIGGER_TYPES, 'manual'] as const;

export const TRIGGER_EXECUTION_STATUSES = ['running', 'success', 'failed'] as const;
export type TriggerExecutionStatus = (typeof TRIGGER_EXECUTION_STATUSES)[number];

export const WORKFLOW_EXECUTION_STATUSES = ['running', 'completed', 'failed'] as const;
export type WorkflowExecutionStatus = (typeof WORKFLOW_EXECUTION_STATUSES)[number];

/**
 * A trigger: something that fires, and what to do when it does.
 *
 * `action_*` is the only group that always applies (Mongoose had it `required`).
 * `integration_event_filters` is `jsonb` — an arbitrary matcher supplied by the
 * caller, whose shape belongs to whichever service is being filtered.
 */
export const triggers = pgTable(
  'triggers',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    name: text().notNull(),
    description: text(),
    type: text({ enum: TRIGGER_TYPES as unknown as [string, ...string[]] }).notNull(),
    enabled: boolean().notNull().default(true),

    actionPrompt: text().notNull(),
    /** An `agents` row. No foreign key — that table is batch 9. */
    actionAgentId: text(),
    actionUseTools: boolean().notNull().default(false),
    actionNotify: boolean().notNull().default(false),
    actionChannelId: text(),

    scheduleType: text({ enum: TRIGGER_SCHEDULE_TYPES as unknown as [string, ...string[]] }),
    scheduleCron: text(),
    /** `HH:MM` for the `daily` kind. Text, not a time — it is paired with a timezone. */
    scheduleTime: text(),
    scheduleDays: text().array(),
    scheduleIntervalMinutes: integer(),
    /** An IANA zone name. No CHECK — the set is the tz database, not ours. */
    scheduleTimezone: text(),

    /** The public URL's path segment, and a LOOKUP KEY. See the file comment. */
    webhookToken: text(),
    /** An optional HMAC secret for payload verification. A credential. */
    webhookSecret: text(),
    webhookAllowedIps: text().array(),

    /** An `integrations` row. No foreign key: an execution record outlives it. */
    integrationEventIntegrationId: text(),
    integrationEventService: text(),
    integrationEventEvent: text(),
    integrationEventFilters: jsonb(),

    lastTriggeredAt: timestamptz(),
    nextTriggerAt: timestamptz(),
    triggerCount: integer().notNull().default(0),
    lastStatus: text({ enum: TRIGGER_LAST_STATUSES as unknown as [string, ...string[]] }),
    lastResult: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('triggers_oxy_user_id_idx').on(t.oxyUserId),
    index('triggers_oxy_user_type_idx').on(t.oxyUserId, t.type),
    index('triggers_type_enabled_idx').on(t.type, t.enabled),
    // The inbound-webhook lookup. Partial, the equivalent of Mongo's `sparse`.
    index('triggers_webhook_token_idx')
      .on(t.webhookToken)
      .where(sql`${t.webhookToken} is not null`),
    index('triggers_integration_event_idx')
      .on(t.integrationEventService, t.integrationEventEvent)
      .where(sql`${t.integrationEventService} is not null`),
    checkOneOf('triggers_type_check', t.type, TRIGGER_TYPES),
    checkOneOf('triggers_schedule_type_check', t.scheduleType, TRIGGER_SCHEDULE_TYPES),
    checkOneOf('triggers_last_status_check', t.lastStatus, TRIGGER_LAST_STATUSES),
  ],
);

/**
 * One run of a trigger.
 *
 * TTL: 30 days from `started_at`. The table carries no `created_at` — Mongoose
 * set `timestamps: false` and `started_at` is the clock, so the sweep measures
 * from the same column the TTL index did.
 *
 * `trigger_id` carries NO foreign key. This is an append-only record of what a
 * trigger DID, so the `api_usage.key_id` reasoning applies: a cascade deletes the
 * evidence, `SET NULL` destroys the attribution that is the row's content, and
 * `RESTRICT` makes a trigger undeletable. The 30-day sweep bounds how long an id
 * can dangle.
 *
 * `input_payload` and `tool_calls` are `jsonb`: an inbound webhook body whose
 * shape belongs to the sender, and an ordered list of calls read whole for
 * display. `tokens_*` are columns — a fixed shape this service owns.
 */
export const triggerExecutions = pgTable(
  'trigger_executions',
  {
    id: generatedId(),
    triggerId: text().notNull(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    status: text({ enum: TRIGGER_EXECUTION_STATUSES as unknown as [string, ...string[]] }).notNull(),
    /** Includes `manual`, which is not a trigger kind. See the tuple. */
    triggerType: text({
      enum: TRIGGER_EXECUTION_TRIGGER_TYPES as unknown as [string, ...string[]],
    }).notNull(),

    inputEvent: text(),
    inputPayload: jsonb(),
    inputSource: text(),

    result: text(),
    toolCalls: jsonb(),

    tokensPrompt: integer(),
    tokensCompletion: integer(),
    tokensTotal: integer(),
    durationMs: integer(),

    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),
  },
  (t) => [
    index('trigger_executions_trigger_started_idx').on(t.triggerId, t.startedAt.desc()),
    index('trigger_executions_oxy_user_id_idx').on(t.oxyUserId),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('trigger_executions_started_at_idx').on(t.startedAt),
    checkOneOf('trigger_executions_status_check', t.status, TRIGGER_EXECUTION_STATUSES),
    checkOneOf(
      'trigger_executions_trigger_type_check',
      t.triggerType,
      TRIGGER_EXECUTION_TRIGGER_TYPES,
    ),
  ],
);

/**
 * A node-graph workflow.
 *
 * `nodes` and `edges` are `jsonb`. An edge's `source`/`target` name a node's
 * `id`, but that is a reference WITHIN the document — there is no cross-table
 * relationship for a child table to make checkable, and the graph is read and
 * written whole by the editor. This is the `fallback_events.attempts` shape;
 * `node.data` is additionally an arbitrary per-node-type payload.
 *
 * Mongoose maintained `updatedAt` with a `pre('save')` hook. That is replaced by
 * the standard `updatedAt()` column builder, which `@oxyhq/db` maintains on every
 * `db.update()` — the same guarantee, expressed where the column is declared
 * rather than in a hook nothing in this schema could see.
 */
export const workflows = pgTable(
  'workflows',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    /** The caller's own id for the workflow, and how executions name it. */
    workflowId: text().notNull(),
    name: text().notNull(),
    description: text(),
    nodes: jsonb().notNull().default([]),
    edges: jsonb().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workflows_workflow_id_key').on(t.workflowId),
    index('workflows_oxy_user_id_idx').on(t.oxyUserId),
  ],
);

/**
 * One run of a workflow.
 *
 * `workflow_id` names `workflows.workflow_id` and carries no foreign key, for
 * the reason `trigger_executions.trigger_id` does not — this is the record of
 * what ran, and it must outlive the workflow being edited or deleted. Unlike
 * `trigger_executions` it has NO TTL, because Mongo declared none: adding one
 * would delete history the source kept.
 *
 * `results` is `jsonb` — per-node outputs whose shape is the node type's, read
 * whole when the run is displayed.
 */
export const workflowExecutions = pgTable(
  'workflow_executions',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    workflowId: text().notNull(),
    /** The caller's own id for this run. */
    executionId: text().notNull(),
    status: text({ enum: WORKFLOW_EXECUTION_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('running'),
    results: jsonb().notNull().default([]),
    finalOutput: text().notNull().default(''),
    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),
  },
  (t) => [
    uniqueIndex('workflow_executions_execution_id_key').on(t.executionId),
    index('workflow_executions_workflow_id_idx').on(t.workflowId),
    index('workflow_executions_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('workflow_executions_status_check', t.status, WORKFLOW_EXECUTION_STATUSES),
  ],
);
