/**
 * The feature catalogue, on Postgres.
 *
 * `feature_id` is the business key, and the target of `plan_features.feature_id`
 * — so deleting a feature cascades its mappings away, exactly as deleting a plan
 * does. See `planRepository.ts` for why that is not the source's behaviour.
 */

import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { features } from '../schema/billing';

export type FeatureRow = typeof features.$inferSelect;
export type FeatureInsert = typeof features.$inferInsert;
export type FeatureUpdate = Partial<Omit<FeatureInsert, 'id' | 'featureId' | 'createdAt'>>;

/** Both keys the routes filter on, and no more. */
export interface FeatureFilter {
  readonly category?: string;
  readonly isActive?: boolean;
}

function featureWhere(filter: FeatureFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.category !== undefined) conditions.push(eq(features.category, filter.category));
  if (filter.isActive !== undefined) conditions.push(eq(features.isActive, filter.isActive));
  return conditions.length ? and(...conditions) : undefined;
}

/** Features matching the filter, in display order. */
export async function selectFeatures(
  db: ApiDatabase,
  filter: FeatureFilter = {},
): Promise<FeatureRow[]> {
  return db
    .select()
    .from(features)
    .where(featureWhere(filter))
    .orderBy(asc(features.category), asc(features.sortOrder));
}

export async function findFeatureByFeatureId(
  db: ApiDatabase,
  featureId: string,
): Promise<FeatureRow | null> {
  const [row] = await db.select().from(features).where(eq(features.featureId, featureId));
  return row ?? null;
}

export async function insertFeature(db: ApiDatabase, values: FeatureInsert): Promise<FeatureRow> {
  const [row] = await db.insert(features).values(values).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Apply an update to one feature; `null` means there is no such feature. */
export async function updateFeatureByFeatureId(
  db: ApiDatabase,
  featureId: string,
  updates: FeatureUpdate,
): Promise<FeatureRow | null> {
  if (Object.keys(updates).length === 0) return findFeatureByFeatureId(db, featureId);
  const [row] = await db
    .update(features)
    .set(updates)
    .where(eq(features.featureId, featureId))
    .returning();
  return row ?? null;
}

export async function deleteFeatureByFeatureId(
  db: ApiDatabase,
  featureId: string,
): Promise<FeatureRow | null> {
  const [row] = await db.delete(features).where(eq(features.featureId, featureId)).returning();
  return row ?? null;
}

/**
 * The seed's upsert: insert only, never touch an existing row.
 *
 * The source was `$setOnInsert`-only with `upsert: true`, and per the porting
 * rule that shape is answered EXACTLY by `rowCount` — `DO NOTHING` writes a row
 * or it does not, with no update branch to confuse the count. No `xmax` needed
 * here, unlike `seedPlan`, which also has a `$set`.
 */
export async function seedFeature(
  db: ApiDatabase,
  values: FeatureInsert,
): Promise<{ inserted: boolean }> {
  const result = await db
    .insert(features)
    .values(values)
    .onConflictDoNothing({ target: features.featureId });
  return { inserted: (result.count ?? 0) > 0 };
}

/** Every feature, in display order — the broadcast payload. */
export async function selectAllFeatures(db: ApiDatabase): Promise<FeatureRow[]> {
  return db.select().from(features).orderBy(asc(features.category), asc(features.sortOrder));
}
