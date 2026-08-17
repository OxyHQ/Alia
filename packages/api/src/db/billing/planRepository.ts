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
 * Which models a plan grants, changed by a person and recorded as such
 * (#139 workstream 14).
 *
 * The ONE runtime writer of `plans.model_ids`, and the reason the seeder below
 * no longer touches that column. `plan_access.ts` reads `model_ids` to decide
 * whether a request may name a model at all, so this is a routing decision
 * wearing a billing table's name — which is why the record goes through
 * `lib/security/config-audit.ts` beside the five provider tables rather than
 * through anything of its own.
 *
 * `actor` is required and has no default. An audit log whose actor defaults to
 * `system` says `system` for the one change somebody needs to attribute.
 *
 * `modelIds` is the only column this can write. Not by convention — by
 * signature: there is no `updates` object to widen, so a caller cannot reach
 * `monthly_price` through here even by passing one. The plan's identity, its
 * price and its Stripe ids are all unreachable.
 *
 * The read and the write share one transaction, so `before` is the state this
 * statement replaced rather than whatever the row held when a second query
 * happened to run.
 */
export async function setPlanModelIds(
  db: ApiDatabase,
  planId: string,
  modelIds: readonly string[],
  actor: ConfigAuditActor,
): Promise<PlanRow | null> {
  return db.transaction(async (tx) => {
    const previous = await findPlanByPlanId(tx, planId);
    if (previous === null) return null;

    const [row] = await tx
      .update(plans)
      .set({ modelIds: [...modelIds] })
      .where(eq(plans.planId, planId))
      .returning();
    if (!row) return null;

    recordConfigChange({
      resource: 'plan',
      action: 'update',
      target: row.planId,
      actor,
      before: auditedFields('plan', previous),
      after: auditedFields('plan', row),
    });
    return row;
  });
}

/**
 * The seed's insert: create a plan that does not exist, and touch nothing that
 * does.
 *
 * ## It used to refresh `model_ids`, and that was a bug
 *
 * The upsert was `onConflictDoUpdate({ set: { modelIds } })`, carrying the
 * Mongo-era belief that the list is code-managed. Nothing ran the seeder, so
 * the belief was never tested. Wiring it up while it still overwrote would have
 * silently reverted every change made through {@link setPlanModelIds} on the
 * next deploy — a runtime writer and a boot writer cannot both be authoritative
 * for one column, and the runtime one is, because that is what
 * *"allow the product team to select which models are available per plan"*
 * means.
 *
 * So this is seed data in the strict sense: a default for a database that has
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
