/**
 * Canvas workflows and their runs, on Postgres.
 *
 * `workflows` and `workflow_executions` move together: no file touches one
 * without the other, and deleting a workflow deletes its runs in the same
 * handler. `workflow_id` is the CALLER's id (a `randomUUID()` minted by the
 * route), not the primary key — it is what the wire contract calls `id` and
 * what an execution names its workflow by.
 *
 * ## `updated_at` had TWO hand-maintained authorities, and both are gone
 *
 * `WorkflowSchema` declared `createdAt`/`updatedAt` by hand with
 * `default: Date.now` and NO `{timestamps: true}`, then kept `updatedAt` fresh
 * two separate ways: a `pre('save')` hook, and an explicit
 * `updatedAt: new Date()` in the route's update document — which was NOT
 * redundant, because a `pre('save')` hook never fires on `findOneAndUpdate`.
 *
 * `@oxyhq/db`'s `updatedAt()` carries `$onUpdate`, so drizzle writes the column
 * on every `db.update()` and on an `onConflictDoUpdate` set. Two hand-maintained
 * authorities collapse into one structural one, expressed where the column is
 * declared.
 *
 * **The caveat is that `$onUpdate` is drizzle-side.** It does not apply to a raw
 * `db.execute`, exactly as `mode: 'number'` does not — a raw statement touching
 * these tables has to set `updated_at` itself. Nothing here uses one.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { workflowExecutions, workflows } from '../schema/automation';
import type { WorkflowExecutionStatus } from '../schema/automation';

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowExecutionRow = typeof workflowExecutions.$inferSelect;

/** The columns the list endpoint projects. `id` is the caller's `workflowId`. */
export interface WorkflowSummary {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string | null;
  readonly nodes: unknown;
  readonly edges: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A user's workflows, most recently touched first. */
export async function listWorkflows(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<WorkflowSummary[]> {
  return db
    .select({
      workflowId: workflows.workflowId,
      name: workflows.name,
      description: workflows.description,
      nodes: workflows.nodes,
      edges: workflows.edges,
      createdAt: workflows.createdAt,
      updatedAt: workflows.updatedAt,
    })
    .from(workflows)
    .where(eq(workflows.oxyUserId, oxyUserId))
    .orderBy(desc(workflows.updatedAt))
    .limit(100);
}

/**
 * One workflow, scoped by owner.
 *
 * `workflow_id` is globally unique, so the owner predicate cannot change WHICH
 * row is found — it decides whether another account's workflow is a 404 rather
 * than a read. Keeping it is the whole access check.
 */
export async function findWorkflow(
  db: ApiDatabase,
  oxyUserId: string,
  workflowId: string,
): Promise<WorkflowRow | undefined> {
  const rows = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.oxyUserId, oxyUserId), eq(workflows.workflowId, workflowId)))
    .limit(1);
  return rows[0];
}

export interface NewWorkflow {
  readonly oxyUserId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly nodes: unknown;
  readonly edges: unknown;
}

export async function createWorkflow(db: ApiDatabase, workflow: NewWorkflow): Promise<WorkflowRow> {
  const rows = await db.insert(workflows).values(workflow).returning();
  const row = rows[0];
  if (!row) throw new Error('workflow insert returned no row');
  return row;
}

/**
 * Change a workflow, addressed by the caller's id and scoped by owner.
 *
 * Every field is optional and an `undefined` is omitted from the statement by
 * drizzle, which is what the source relied on: the route spreads `req.body`
 * straight in, so a PUT naming only `name` must leave the graph alone.
 *
 * Returns `undefined` when nothing matched, which the route turns into a 404.
 */
export async function updateWorkflow(
  db: ApiDatabase,
  oxyUserId: string,
  workflowId: string,
  patch: {
    name?: string;
    description?: string;
    nodes?: unknown;
    edges?: unknown;
  },
): Promise<WorkflowRow | undefined> {
  const rows = await db
    .update(workflows)
    .set(patch)
    .where(and(eq(workflows.oxyUserId, oxyUserId), eq(workflows.workflowId, workflowId)))
    .returning();
  return rows[0];
}

/** Remove a workflow. Returns `undefined` when the caller does not own one. */
export async function deleteWorkflow(
  db: ApiDatabase,
  oxyUserId: string,
  workflowId: string,
): Promise<WorkflowRow | undefined> {
  const rows = await db
    .delete(workflows)
    .where(and(eq(workflows.oxyUserId, oxyUserId), eq(workflows.workflowId, workflowId)))
    .returning();
  return rows[0];
}

/**
 * Remove every run of a workflow.
 *
 * Deliberately NOT scoped by owner, matching the source. The caller reaches
 * this only after `deleteWorkflow` confirmed ownership, and `workflow_id` is
 * globally unique, so the owner predicate would select the same rows. There is
 * no foreign key doing this — `workflow_executions` outlives its workflow by
 * design, so the cascade is the handler's decision rather than the schema's.
 */
export async function deleteExecutionsForWorkflow(
  db: ApiDatabase,
  workflowId: string,
): Promise<void> {
  await db.delete(workflowExecutions).where(eq(workflowExecutions.workflowId, workflowId));
}

/** A workflow's run history, most recent first. */
export async function listExecutions(
  db: ApiDatabase,
  oxyUserId: string,
  workflowId: string,
): Promise<WorkflowExecutionRow[]> {
  return db
    .select()
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.oxyUserId, oxyUserId),
        eq(workflowExecutions.workflowId, workflowId),
      ),
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(50);
}

export interface NewWorkflowExecution {
  readonly oxyUserId: string;
  readonly workflowId: string;
  readonly executionId: string;
  readonly startedAt: Date;
}

/** Open a run. `status`, `results` and `final_output` take their defaults. */
export async function createExecution(
  db: ApiDatabase,
  execution: NewWorkflowExecution,
): Promise<WorkflowExecutionRow> {
  const rows = await db.insert(workflowExecutions).values(execution).returning();
  const row = rows[0];
  if (!row) throw new Error('workflow execution insert returned no row');
  return row;
}

/**
 * Close a run.
 *
 * The source mutated the hydrated document and called `save()` on both the
 * success and the failure path. There is no equivalent, so the terminal write
 * is one explicit statement — which also makes it impossible to close a run
 * without saying what happened to it.
 */
export async function completeExecution(
  db: ApiDatabase,
  executionId: string,
  outcome: {
    status: WorkflowExecutionStatus;
    results?: unknown;
    finalOutput: string;
    completedAt: Date;
  },
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set(outcome)
    .where(eq(workflowExecutions.executionId, executionId));
}

/**
 * The account a run belongs to, for the socket room's ownership check.
 *
 * Returns just the owner because that is all `subscribe-workflow` needs, and a
 * narrow projection keeps a run's payload out of a path whose only job is to
 * answer "may this socket join".
 */
export async function findExecutionOwner(
  db: ApiDatabase,
  executionId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ oxyUserId: workflowExecutions.oxyUserId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.executionId, executionId))
    .limit(1);
  return rows[0]?.oxyUserId;
}
