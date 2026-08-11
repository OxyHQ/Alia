/**
 * Payments, refunds and credit grants, on Postgres.
 *
 * ## `dedup_key` is the double-credit guard, and it must keep working
 *
 * `routes/billing.ts` credits a subscription renewal by INSERTING a transaction
 * first as a lock, keyed `<stripeSubscriptionId>_<periodStart>`, and treats the
 * duplicate-key error as "already credited, skip". In Mongo that lived in a
 * unique index on a path inside a `Mixed` field; here it is a STORED GENERATED
 * column over `metadata ->> 'dedup'` with a unique index, so callers keep passing
 * `metadata: { dedup }` and there is no way to write the metadata without the
 * constraint seeing it.
 *
 * **The port's hazard is not the column, it is the catch.** A drizzle error's
 * SQLSTATE lives on `cause`, never `error.code`, so a mechanically ported
 * `err.code === 11000` — or even `=== '23505'` — matches NOTHING, the branch
 * collapses, the error propagates past the skip, and the customer is credited
 * twice on the next webhook redelivery. `isDuplicateTransaction` below is the
 * one place that test is written, by constraint name, and
 * `billingRepository.pgdb.test.ts` fails if it stops firing.
 */

import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import type { ApiDatabase } from '../index';
import { transactions } from '../schema/billing';

export type TransactionRow = typeof transactions.$inferSelect;
export type TransactionInsert = typeof transactions.$inferInsert;

/** The two unique indexes that mean "this payment was already recorded". */
const DEDUP_CONSTRAINTS = new Set([
  'transactions_dedup_key_key',
  'transactions_stripe_payment_intent_id_key',
]);

/**
 * Whether an error means "this transaction is already recorded".
 *
 * By CONSTRAINT NAME, so an unrelated unique violation is not silently swallowed
 * as a duplicate webhook — which would drop a real payment record.
 */
export function isDuplicateTransaction(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const name = constraintNameOf(error);
  // An unnamed unique violation is NOT treated as a duplicate: swallowing one
  // would drop a real payment record, which is the worse of the two mistakes.
  return name !== undefined && DEDUP_CONSTRAINTS.has(name);
}

export async function insertTransaction(
  db: ApiDatabase,
  values: TransactionInsert,
): Promise<TransactionRow> {
  const [row] = await db.insert(transactions).values(values).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** One account's transactions, newest first. `limit` with no `offset` for the admin summary. */
export async function selectTransactionsForUser(
  db: ApiDatabase,
  oxyUserId: string,
  page: { limit: number; offset?: number },
): Promise<TransactionRow[]> {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.oxyUserId, oxyUserId))
    .orderBy(desc(transactions.createdAt))
    .limit(page.limit)
    .offset(page.offset ?? 0);
}

export async function countTransactionsForUser(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<number> {
  // `count()` is `bigint` on the wire; drizzle's own helper maps it to a number,
  // which a bare `sql`count(*)`` would not.
  const [row] = await db
    .select({ total: count() })
    .from(transactions)
    .where(eq(transactions.oxyUserId, oxyUserId));
  return row?.total ?? 0;
}

export interface AdminTransactionFilter {
  readonly status?: string;
  readonly type?: string;
}

function adminWhere(filter: AdminTransactionFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.status !== undefined) conditions.push(eq(transactions.status, filter.status));
  if (filter.type !== undefined) conditions.push(eq(transactions.type, filter.type));
  return conditions.length ? and(...conditions) : undefined;
}

/** The admin list, newest first. */
export async function selectTransactions(
  db: ApiDatabase,
  filter: AdminTransactionFilter,
  page: { limit: number; offset: number },
): Promise<TransactionRow[]> {
  return db
    .select()
    .from(transactions)
    .where(adminWhere(filter))
    .orderBy(desc(transactions.createdAt))
    .limit(page.limit)
    .offset(page.offset);
}

export async function countTransactions(
  db: ApiDatabase,
  filter: AdminTransactionFilter,
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(transactions).where(adminWhere(filter));
  return row?.total ?? 0;
}
