/**
 * One-off credit purchase packages, on Postgres.
 *
 * `package_id` is the business key. `credits >= 1` and `price >= 0` are CHECK
 * constraints rather than route validation — the routes still validate, so a bad
 * request gets a 400 rather than a 500, but the CHECK is what makes a package
 * granting no credits unrepresentable however it is written.
 */

import { asc, eq, type SQL } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { creditPackages } from '../schema/billing';

type CreditPackageRow = typeof creditPackages.$inferSelect;
type CreditPackageInsert = typeof creditPackages.$inferInsert;

/** Packages, optionally only the active ones, in display order. */
export async function selectCreditPackages(
  db: ApiDatabase,
  filter: { isActive?: boolean } = {},
): Promise<CreditPackageRow[]> {
  const where: SQL | undefined =
    filter.isActive === undefined ? undefined : eq(creditPackages.isActive, filter.isActive);
  return db.select().from(creditPackages).where(where).orderBy(asc(creditPackages.sortOrder));
}

/**
 * The seed's upsert: insert only, never touch an existing row.
 *
 * `$setOnInsert`-only with `upsert: true`, which the porting rule says is
 * answered EXACTLY by `rowCount` — `DO NOTHING` writes a row or it does not, and
 * there is no update branch for the count to confuse.
 */
export async function seedCreditPackage(
  db: ApiDatabase,
  values: CreditPackageInsert,
): Promise<{ inserted: boolean }> {
  const result = await db
    .insert(creditPackages)
    .values(values)
    .onConflictDoNothing({ target: creditPackages.packageId });
  return { inserted: (result.count ?? 0) > 0 };
}
