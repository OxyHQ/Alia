/**
 * The plan catalogue, on Postgres.
 *
 * `plan_id` is the business key every other table and every caller names a plan
 * by — `plans.id` is a surrogate nothing outside this file mentions. So every
 * function here takes and returns `planId`.
 *
 * ## Deleting a plan now takes its feature mappings with it
 *
 * `plan_features.plan_id` is a foreign key to `plans.plan_id` with
 * `ON DELETE CASCADE`. Mongo left the mappings behind as orphans, where a plan
 * re-created under the same id silently inherited the withdrawn one's
 * entitlements. That is a deliberate change and it belongs to the schema rather
 * than to this file; it is stated here because `deletePlanByPlanId` is where it
 * happens.
 */

import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { plans } from '../schema/billing';
import {
  auditedFields,
  recordConfigChange,
  type ConfigAuditActor,
} from '../../lib/security/config-audit.js';

export type PlanRow = typeof plans.$inferSelect;
export type PlanInsert = typeof plans.$inferInsert;
export type PlanUpdate = Partial<Omit<PlanInsert, 'id' | 'planId' | 'createdAt'>>;

/**
 * The filter every caller actually uses.
 *
 * The Mongoose version took an arbitrary `Record<string, unknown>` and handed it
 * to `find()`. Four keys are used across the whole repository — measured, not
 * assumed — so this is the closed set. An open filter object cannot be ported to
 * a query builder without either writing an interpreter or telling a lie about
 * what it supports.
 */
export interface PlanFilter {
  readonly planId?: string;
  readonly product?: string;
  readonly isActive?: boolean;
  readonly isFree?: boolean;
}

function planWhere(filter: PlanFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.planId !== undefined) conditions.push(eq(plans.planId, filter.planId));
  if (filter.product !== undefined) conditions.push(eq(plans.product, filter.product));
  if (filter.isActive !== undefined) conditions.push(eq(plans.isActive, filter.isActive));
  if (filter.isFree !== undefined) conditions.push(eq(plans.isFree, filter.isFree));
  return conditions.length ? and(...conditions) : undefined;
}

/** Plans matching the filter, in the catalogue's display order. */
export async function selectPlans(db: ApiDatabase, filter: PlanFilter = {}): Promise<PlanRow[]> {
  return db
    .select()
    .from(plans)
    .where(planWhere(filter))
    .orderBy(asc(plans.product), asc(plans.sortOrder));
}

export async function findPlanByPlanId(db: Executor, planId: string): Promise<PlanRow | null> {
  const [row] = await db.select().from(plans).where(eq(plans.planId, planId));
  return row ?? null;
}

export async function insertPlan(db: ApiDatabase, values: PlanInsert): Promise<PlanRow> {
  const [row] = await db.insert(plans).values(values).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/**
 * Apply an update to one plan, answering `null` when there is no such plan.
 *
 * The empty RETURNING set IS "no such plan" — the same discrimination the source
 * got from `findOneAndUpdate` returning null, and a real failure still
 * propagates as an exception rather than reading as a miss. An empty `updates`
 * object would produce invalid SQL, so it short-circuits to a plain read, which
 * is what `$set: {}` amounted to.
 */
export async function updatePlanByPlanId(
  db: ApiDatabase,
  planId: string,
  updates: PlanUpdate,
): Promise<PlanRow | null> {
  if (Object.keys(updates).length === 0) return findPlanByPlanId(db, planId);
  const [row] = await db.update(plans).set(updates).where(eq(plans.planId, planId)).returning();
  return row ?? null;
}

/** Delete one plan, answering `null` when there was none. */
export async function deletePlanByPlanId(db: ApiDatabase, planId: string): Promise<PlanRow | null> {
  const [row] = await db.delete(plans).where(eq(plans.planId, planId)).returning();
  return row ?? null;
}

/**
 * The seed's insert: create a plan that does not exist, and touch nothing that
 * does.
 *
 * Seed data in the strict sense: a default for a database that has
 * none, never a correction to one that does.
 *
 * ## `DO NOTHING RETURNING` returns NO ROW on conflict
 *
 * Which is what makes `inserted` readable without `xmax`: an empty result IS
 * the conflict branch. The previous version could not use the row count —
 * `rowCount` is 1 either way, like Mongo's `matchedCount` — and needed
 * `(xmax = 0)` to recover the insert branch. It does not need it now, and a
 * caller that wanted the existing row back would have to read it explicitly
 * rather than assume this returned one.
 */
export async function seedPlan(
  db: ApiDatabase,
  values: PlanInsert,
  actor: ConfigAuditActor,
): Promise<{ inserted: boolean }> {
  const rows = await db.insert(plans).values(values).onConflictDoNothing({ target: plans.planId }).returning();
  const row = rows[0];
  if (row === undefined) return { inserted: false };

  // A create: `before` is null, and the plan's model list starts here.
  recordConfigChange({
    resource: 'plan',
    action: 'create',
    target: row.planId,
    actor,
    before: null,
    after: auditedFields('plan', row),
  });
  return { inserted: true };
}
