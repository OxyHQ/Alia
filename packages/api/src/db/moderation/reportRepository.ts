/**
 * Reports, on Postgres.
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

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import type { ApiDatabase, Executor } from '../index';
import { getDb } from '../index';
import { reports } from '../schema/moderation';
import type { ReportCategory } from '../../domain/report.js';
import {
  enqueueModerationOutboxEvent,
  type ModerationOutboxKind,
  type ModerationOutboxPayload,
} from './outboxRepository';

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

export type StoredReport = typeof reports.$inferSelect;

export interface NewReport {
  readonly id: string;
  readonly reportedType: string;
  readonly reportedId: string;
  readonly reporter: string;
  readonly categories: readonly ReportCategory[];
  readonly details?: string;
  readonly localStatus: string;
  readonly localStatusReason?: string;
}

/** What to enqueue alongside the report, when there is somewhere to send it. */
export interface NewOutboxEvent {
  readonly eventId: string;
  readonly kind: ModerationOutboxKind;
  readonly payload: ModerationOutboxPayload;
}

export type CreateReportResult =
  | { readonly created: true; readonly report: StoredReport }
  | { readonly created: false; readonly existing: StoredReport };

/**
 * Store a report and, when it is deliverable, queue its delivery — in ONE
 * transaction, so a report can never commit as `queued` with nothing to deliver
 * it, nor as `received` with a delivery event that will try anyway.
 *
 * The enqueue goes through `enqueueModerationOutboxEvent` rather than inserting
 * the row here, so this path is subject to the same transaction guard as the
 * inbound one and the outbox keeps a single writer. Handing it `tx` is the whole
 * mechanism; handing it the root connection is the mistake that guard exists to
 * refuse.
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

    if (event) await enqueueModerationOutboxEvent(tx, event);

    return { created: true, report: inserted };
  });
}

/** One report, for the delivery worker. */
export async function findReportById(id: string): Promise<StoredReport | null> {
  const [row] = await getDb().select().from(reports).where(eq(reports.id, id));
  return row ?? null;
}

/**
 * Close a report there is genuinely nothing left to do about — the reported
 * object is gone, or was never somebody's published work.
 */
export async function closeUndeliverableReport(id: string, reason: string): Promise<void> {
  await getDb()
    .update(reports)
    .set({ localStatus: 'closed', localStatusReason: reason, updatedAt: sql`now()` })
    .where(eq(reports.id, id));
}

/**
 * Record a delivery failure ON THE REPORT, not only in the outbox row.
 *
 * `delivery_failed` is what a reporter's receipt and any operational sweep both
 * read; leaving the report at `queued` while the outbox quietly backed off would
 * hide the problem in a table nobody looks at.
 */
export async function markReportDeliveryFailed(id: string, message: string): Promise<void> {
  await getDb()
    .update(reports)
    .set({
      localStatus: 'delivery_failed',
      lastDeliveryError: message.slice(0, 2_000),
      updatedAt: sql`now()`,
    })
    .where(eq(reports.id, id));
}

/**
 * Record a successful delivery.
 *
 * `lastDeliveryError` and `localStatusReason` are cleared — Mongo's `$unset`.
 * Setting them to `null` is the same fact here, because the columns are nullable
 * and absence is spelled `NULL` rather than "key not present".
 */
export async function markReportSubmitted(
  id: string,
  receipt: {
    crowdSourceReportId: string;
    crowdSourceCaseId: string;
    crowdSourceMerged: boolean;
    contentSnapshotHash: string;
  },
): Promise<void> {
  await getDb()
    .update(reports)
    .set({
      localStatus: 'submitted',
      crowdSourceReportId: receipt.crowdSourceReportId,
      crowdSourceCaseId: receipt.crowdSourceCaseId,
      crowdSourceMerged: receipt.crowdSourceMerged,
      contentSnapshotHash: receipt.contentSnapshotHash,
      submittedAt: sql`now()`,
      lastDeliveryError: null,
      localStatusReason: null,
      updatedAt: sql`now()`,
    })
    .where(eq(reports.id, id));
}

/** Every report that opened or joined this case, for the decision worker. */
export async function findReportsByCaseId(
  caseId: string,
): Promise<Pick<StoredReport, 'id' | 'reportedType' | 'reportedId'>[]> {
  return await getDb()
    .select({
      id: reports.id,
      reportedType: reports.reportedType,
      reportedId: reports.reportedId,
    })
    .from(reports)
    .where(eq(reports.crowdSourceCaseId, caseId))
    /**
     * Ordered, where Mongo's `find` was not.
     *
     * The caller takes `reports[0]` as the case's subject, so an unordered query
     * makes that an arbitrary row — harmless while §7.3's dedup key guarantees
     * every report merged into a case is about the SAME object, and a silent
     * nondeterminism the day that stops being true. Oldest first, because the
     * report that opened the case is the one that named it. `id` breaks a tie
     * within a millisecond, which `created_at` alone cannot.
     */
    .orderBy(asc(reports.createdAt), asc(reports.id));
}

export interface ReportDecision {
  readonly status: string;
  readonly localStatus: string;
  readonly decisionId: string;
  readonly decisionRevision: number;
  readonly decisionOutcome: string;
  readonly decisionStatus: string;
  readonly decidedAt: Date;
  readonly enforcedAction?: string;
}

/**
 * Write a decision onto one report, refusing a stale revision.
 *
 * The revision guard is in the WHERE clause, so it is the DATABASE that rejects
 * an out-of-order write rather than a read-then-write in this process.
 * Deliveries can overlap — §10.9 retries for 24 hours, and a correction can
 * arrive while the decision it supersedes is still being applied — and an older
 * revision landing last would otherwise overwrite the current answer with a
 * stale one.
 *
 * `decision_revision IS NULL OR decision_revision <= $revision` is Mongo's
 * `$or: [{$exists: false}, {$lte: …}]` exactly. The `IS NULL` branch is not
 * decoration: in SQL a comparison against NULL is NULL, which a WHERE treats as
 * false, so without it the FIRST decision on a report — the only case where the
 * column is still unset — would match nothing and be silently dropped.
 *
 * Returns whether a row was written. Mongo read `matchedCount` here and
 * Postgres's row count is `matchedCount`, so this is a faithful port; the
 * `RETURNING` is what makes the count readable.
 */
export async function applyDecisionToReport(
  id: string,
  decision: ReportDecision,
): Promise<boolean> {
  const rows = await getDb()
    .update(reports)
    .set({
      status: decision.status,
      localStatus: decision.localStatus,
      decisionId: decision.decisionId,
      decisionRevision: decision.decisionRevision,
      decisionOutcome: decision.decisionOutcome,
      decisionStatus: decision.decisionStatus,
      decidedAt: decision.decidedAt,
      ...(decision.enforcedAction === undefined
        ? {}
        : { enforcedAction: decision.enforcedAction, enforcedAt: sql`now()` }),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(reports.id, id),
        or(
          isNull(reports.decisionRevision),
          lte(reports.decisionRevision, decision.decisionRevision),
        ),
      ),
    )
    .returning({ id: reports.id });
  return rows.length === 1;
}
