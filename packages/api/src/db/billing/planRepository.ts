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

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { plans } from '../schema/billing';

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

export async function findPlanByPlanId(db: ApiDatabase, planId: string): Promise<PlanRow | null> {
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
 * The seed's upsert: refresh the code-managed `model_ids`, set everything else
 * only on first insert.
 *
 * Returns whether a row was INSERTED, which `rowCount` cannot answer — it
 * behaves like Mongo's `matchedCount` and is 1 either way. `xmax` is the id of
 * the transaction that deleted or locked a tuple; one this statement just
 * inserted has none, so `xmax = 0` is true exactly for the insert branch. It is
 * the only way to recover `upsertedCount` from a Postgres upsert.
 */
export async function seedPlan(db: ApiDatabase, values: PlanInsert): Promise<{ inserted: boolean }> {
  const rows = await db
    .insert(plans)
    .values(values)
    .onConflictDoUpdate({
      target: plans.planId,
      // `$set: { modelIds }` in the source: the list is code-managed, so a stale
      // member is corrected on the next boot rather than persisting.
      set: { modelIds: values.modelIds ?? [] },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { inserted: rows[0]?.inserted ?? false };
}
