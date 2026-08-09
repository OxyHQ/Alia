/**
 * Report intake, on Postgres.
 *
 * This file exists for one statement. Everything else here is bookkeeping.
 *
 * ## Why a SAVEPOINT
 *
 * Under Mongo, intake read the report first and threw `DuplicateReportError`
 * carrying the existing document, so the caller could answer "you already
 * reported this" with the real report. That read was also a race the unique
 * index already closed — two concurrent submissions both see nothing and both
 * proceed, and it was always the index that decided the loser.
 *
 * So the correct port drops the pre-check and lets the INSERT fail. That is the
 * right move, and it is precisely what introduces the trap:
 *
 *   **In PostgreSQL a failed statement aborts the ENTIRE transaction.** Every
 *   later statement, including a plain SELECT, fails with `25P02 current
 *   transaction is aborted` until it rolls back.
 *
 * MongoDB has no equivalent — a duplicate-key error leaves the session perfectly
 * usable, which is why the "let it fail and read the row back" shape was fine
 * there and is not here. A handler that reacts to the unique violation by
 * reading the existing report gets `25P02` on that read instead, and returns 500
 * where Mongo returned a friendly 409.
 *
 * The diff that introduces it looks like a strict improvement (a racy pre-check
 * replaced by a real constraint), which is how it gets past review.
 *
 * `insertOrNullOnConflict` wraps only the INSERT in a nested transaction —
 * drizzle's spelling of a SAVEPOINT — so a duplicate rolls back just that and
 * leaves the surrounding transaction usable for the recovery read. See the
 * function's own comment for why a hand-issued `SAVEPOINT` is NOT sufficient on
 * postgres.js; that distinction cost a red suite to find and is invisible in the
 * SQL.
 *
 * **None of this is expressible against a mock.** A mocked `insert` that rejects
 * leaves no aborted transaction behind, so the recovery read succeeds in the
 * test and fails only against a real server. `reportRepository.pgdb.test.ts`
 * runs against real Postgres for exactly this reason.
 */

import { and, eq } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import type { ApiDatabase } from '../index';
import { reports, moderationOutboxes } from '../schema/moderation';

/** A drizzle transaction handle, or the root connection. */
type Executor = ApiDatabase | Parameters<Parameters<ApiDatabase['transaction']>[0]>[0];

/**
 * Run `operation` inside a SAVEPOINT, returning `null` if it raised a unique
 * violation and leaving the surrounding transaction USABLE either way.
 *
 * Any other error is rethrown — a serialization failure or a dropped connection
 * must not be read as "duplicate", the same reason the inbound dedupe claim
 * reads an empty `RETURNING` set rather than catching.
 *
 * ## Use drizzle's NESTED transaction, not a hand-issued `SAVEPOINT`
 *
 * The obvious spelling is `tx.execute(sql`savepoint s`)`, catch, then
 * `tx.execute(sql`rollback to savepoint s`)`. **It does not work on
 * postgres.js**, and it fails in a way that looks like success from inside:
 * measured here, the catch runs, `isUniqueViolation` reports true, the rollback
 * is issued and a recovery read afterwards returns the right row — and then the
 * whole transaction still rejects at COMMIT with the original duplicate-key
 * error.
 *
 * The reason is that postgres.js tracks a failed query on the transaction
 * itself. Catching the rejection in application code does not un-fail it, so
 * `sql.begin()` rejects regardless of what the savepoint did. The SQL was
 * correct; the driver had already decided.
 *
 * `tx.transaction(...)` is drizzle's nested transaction and compiles to a real
 * SAVEPOINT that postgres.js itself owns, so the driver's own bookkeeping is
 * rolled back with it. That is the difference, and it is invisible in the SQL.
 */
async function insertOrNullOnConflict<T>(
  tx: Executor,
  operation: (sp: Executor) => Promise<T>,
): Promise<T | null> {
  try {
    return await tx.transaction(async (sp) => operation(sp));
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

export interface NewReport {
  readonly id: string;
  readonly reportedType: string;
  readonly reportedId: string;
  readonly reporter: string;
  readonly categories: readonly string[];
  readonly details?: string;
  readonly localStatus: string;
  readonly localStatusReason?: string;
}

export interface NewOutboxEvent {
  readonly id: string;
  readonly kind: 'report.submit' | 'decision.apply';
  readonly payload: unknown;
  readonly availableAt: Date;
  readonly expiresAt: Date;
}

export type CreateReportResult =
  | { readonly created: true; readonly report: typeof reports.$inferSelect }
  | { readonly created: false; readonly existing: typeof reports.$inferSelect };

/**
 * Store a report and, when it is deliverable, queue its delivery — in ONE
 * transaction, so a report can never commit as `queued` with nothing to deliver
 * it, nor as `received` with a delivery event that will try anyway.
 *
 * A duplicate returns `{created: false, existing}` rather than throwing, which
 * is the shape the caller needs to answer 409 with the original report.
 */
export async function createReport(
  db: ApiDatabase,
  report: NewReport,
  event: NewOutboxEvent | null,
): Promise<CreateReportResult> {
  return db.transaction(async (tx) => {
    const inserted = await insertOrNullOnConflict(tx, async (sp) => {
      const [row] = await sp
        .insert(reports)
        .values({
          id: report.id,
          reportedType: report.reportedType,
          reportedId: report.reportedId,
          reporter: report.reporter,
          categories: [...report.categories],
          details: report.details,
          localStatus: report.localStatus,
          localStatusReason: report.localStatusReason,
        })
        .returning();
      return row;
    });

    if (!inserted) {
      // The read that `25P02` would have killed without the savepoint above.
      const [existing] = await tx
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.reporter, report.reporter),
            eq(reports.reportedType, report.reportedType),
            eq(reports.reportedId, report.reportedId),
          ),
        );
      if (!existing) {
        // The unique index fired but the row is not there: it was deleted
        // between the two statements. Genuinely exceptional, and NOT something
        // to paper over with a retry loop inside a transaction.
        throw new Error(
          `Report intake: unique violation for reporter=${report.reporter} but no existing row found`,
        );
      }
      return { created: false, existing };
    }

    if (event) {
      // Deterministic id, so a repeat converges on one row. DO NOTHING rather
      // than DO UPDATE: a repeat must write no tuple version and touch no
      // timestamp, because the dispatcher may hold a lease on this very row.
      await tx
        .insert(moderationOutboxes)
        .values({
          id: event.id,
          kind: event.kind,
          payload: event.payload,
          availableAt: event.availableAt,
          expiresAt: event.expiresAt,
        })
        .onConflictDoNothing();
    }

    return { created: true, report: inserted };
  });
}
