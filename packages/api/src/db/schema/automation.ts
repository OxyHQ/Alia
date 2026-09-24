/**
 * Automation: node-graph workflows and the record of each run.
 *
 * The legacy `triggers` and `trigger_executions` tables were dropped; scheduled
 * and event automations are `automation_definitions` in `schema/agency.ts`.
 */

import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { checkOneOf } from './columns';

export const WORKFLOW_EXECUTION_STATUSES = ['running', 'completed', 'failed'] as const;
export type WorkflowExecutionStatus = (typeof WORKFLOW_EXECUTION_STATUSES)[number];

/**
 * A node-graph workflow.
 *
 * `nodes` and `edges` are `jsonb`. An edge's `source`/`target` name a node's
 * `id`, but that is a reference WITHIN the document — there is no cross-table
 * relationship for a child table to make checkable, and the graph is read and
 * written whole by the editor. `node.data` is additionally an arbitrary
 * per-node-type payload.
 *
 * Mongoose maintained `updatedAt` with a `pre('save')` hook. That is replaced by
 * the standard `updatedAt()` column builder, which `@oxy.so/db` maintains on every
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
 * `workflow_id` names `workflows.workflow_id` and carries no foreign key: this
 * is the record of what ran, and it must outlive the workflow being edited or
 * deleted. It has NO TTL, because Mongo declared none: adding one would delete
 * history the source kept.
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
