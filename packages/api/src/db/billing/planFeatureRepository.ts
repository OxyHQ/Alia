/**
 * Which features a plan grants, on Postgres.
 *
 * ## An upsert here can now be REFUSED, and that is new
 *
 * Both columns carry foreign keys, so a mapping naming a plan or feature that
 * does not exist raises `23503` where Mongo cheerfully created an orphan. The
 * callers translate that into a 400 rather than letting it become a 500 — an
 * orphan mapping was never meaningful, and the schema is where that is now said.
 *
 * ## `modifiedCount` has no exact Postgres equivalent, and this is the
 * approximation, stated
 *
 * Mongo's `modifiedCount` counts documents whose VALUES changed: re-saving a row
 * with identical values gives `matchedCount: 1, modifiedCount: 0`.
 * `ON CONFLICT DO UPDATE` writes the tuple either way, so `modified` below counts
 * rows WRITTEN, not rows whose values differed. For the admin grid's "Save All"
 * — which posts the whole matrix every time — the new reading is the useful one,
 * and recovering the old one would need an `IS DISTINCT FROM` predicate that
 * then makes a no-op indistinguishable from a miss in `RETURNING`.
 *
 * `upserted` IS exact: `xmax = 0` is true precisely for a tuple the statement
 * inserted.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { planFeatures } from '../schema/billing';

export type PlanFeatureRow = typeof planFeatures.$inferSelect;
export type PlanFeatureInsert = typeof planFeatures.$inferInsert;

/** The four fields a mapping's callers set. `undefined` means "leave alone". */
export interface PlanFeatureValues {
  readonly enabled?: boolean;
  readonly limitValue?: number | null;
  readonly displayLabel?: string | null;
  readonly displayDescription?: string | null;
}

/**
 * Only the keys the caller actually supplied.
 *
 * Mongoose strips `undefined` out of a `$set`, so an absent field left the
 * stored value untouched rather than nulling it. Reproducing that means building
 * the update object rather than passing `undefined` through.
 */
function definedOnly(values: PlanFeatureValues): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (values.enabled !== undefined) set.enabled = values.enabled;
  if (values.limitValue !== undefined) set.limitValue = values.limitValue;
  if (values.displayLabel !== undefined) set.displayLabel = values.displayLabel;
  if (values.displayDescription !== undefined) set.displayDescription = values.displayDescription;
  return set;
}

/** Mappings, optionally for one plan, ordered for the admin list. */
export async function selectPlanFeatures(
  db: ApiDatabase,
  filter: { planId?: string } = {},
): Promise<PlanFeatureRow[]> {
  return db
    .select()
    .from(planFeatures)
    .where(filter.planId === undefined ? undefined : eq(planFeatures.planId, filter.planId))
    .orderBy(asc(planFeatures.planId), asc(planFeatures.featureId));
}

/** Every mapping, unordered — the matrix and the broadcast payload. */
export async function selectAllPlanFeatures(db: ApiDatabase): Promise<PlanFeatureRow[]> {
  return db.select().from(planFeatures);
}

/** Create or update one mapping, returning it. */
export async function upsertPlanFeature(
  db: ApiDatabase,
  planId: string,
  featureId: string,
  values: PlanFeatureValues,
): Promise<PlanFeatureRow> {
  const set = definedOnly(values);
  const [row] = await db
    .insert(planFeatures)
    .values({ planId, featureId, ...set })
    .onConflictDoUpdate({
      target: [planFeatures.planId, planFeatures.featureId],
      set: { ...set, updatedAt: sql`date_trunc('milliseconds', now())` },
    })
    .returning();
  if (!row) throw new Error('upsert returned no row');
  return row;
}

export interface BulkUpsertResult {
  readonly upserted: number;
  readonly modified: number;
}

/**
 * The matrix editor's "Save All".
 *
 * One statement per mapping rather than a multi-row `VALUES` list, because each
 * carries a DIFFERENT set of supplied keys — a single statement would have to
 * pick one column list and would null whatever a given row left out.
 */
export async function bulkUpsertPlanFeatures(
  db: ApiDatabase,
  mappings: readonly { planId: string; featureId: string; values: PlanFeatureValues }[],
): Promise<BulkUpsertResult> {
  let upserted = 0;
  let modified = 0;
  for (const m of mappings) {
    const set = definedOnly(m.values);
    const rows = await db
      .insert(planFeatures)
      .values({ planId: m.planId, featureId: m.featureId, ...set })
      .onConflictDoUpdate({
        target: [planFeatures.planId, planFeatures.featureId],
        set: { ...set, updatedAt: sql`date_trunc('milliseconds', now())` },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (rows[0]?.inserted) upserted++;
    else modified++;
  }
  return { upserted, modified };
}

/** Delete one mapping; `null` means there was none. */
export async function deletePlanFeature(
  db: ApiDatabase,
  planId: string,
  featureId: string,
): Promise<PlanFeatureRow | null> {
  const [row] = await db
    .delete(planFeatures)
    .where(and(eq(planFeatures.planId, planId), eq(planFeatures.featureId, featureId)))
    .returning();
  return row ?? null;
}

/**
 * The seed's bulk upsert: insert only, never touch an existing mapping.
 *
 * `$setOnInsert`-only, so `DO NOTHING` and the row count answer it exactly, and
 * the seed's `upserted` figure keeps meaning what it meant.
 */
export async function seedPlanFeatures(
  db: ApiDatabase,
  mappings: readonly PlanFeatureInsert[],
): Promise<{ upserted: number }> {
  if (mappings.length === 0) return { upserted: 0 };
  const rows = await db
    .insert(planFeatures)
    .values([...mappings])
    .onConflictDoNothing({ target: [planFeatures.planId, planFeatures.featureId] })
    .returning({ id: planFeatures.id });
  return { upserted: rows.length };
}
