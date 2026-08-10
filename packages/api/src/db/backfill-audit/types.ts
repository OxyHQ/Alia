import type { Db } from 'mongodb';

/**
 * The contract every backfill audit check implements.
 *
 * The audit list in `db/schema/CONVENTIONS.md` is prose: fifteen or so findings
 * that say what the port tightened and how the copy can fail. This turns each
 * into something that RUNS against the source database, because a finding
 * nobody executes is indistinguishable from a finding nobody had.
 */

/**
 * What a non-zero result MEANS, which is not the same question as how big it is.
 *
 * - `blocking` — the copy will FAIL on these rows. Postgres will refuse them, so
 *   the number is a work item that must be resolved (or explicitly discarded)
 *   before the backfill runs.
 * - `informational` — the copy will succeed and the number is a fact somebody
 *   needs in order to decide something. A count that nobody has to act on still
 *   belongs here; what it must not do is read as an all-clear.
 *
 * The distinction is in the TYPE rather than in a doc comment because the runner
 * exits non-zero on a blocking finding and zero on an informational one, and
 * those are opposite instructions to whoever is watching.
 */
export type AuditSeverity = 'blocking' | 'informational';

/** One measured fact. A check may return several. */
export interface AuditFinding {
  /** Stable, greppable identity for this specific measurement. */
  readonly key: string;
  /** What was counted, in the words somebody reading the output needs. */
  readonly subject: string;
  readonly count: number;
  /**
   * A bounded sample of the offending values, so a non-zero count can be
   * investigated without a second query. Ids only — never a document, never a
   * field value, because an audit that prints user content is a data export.
   */
  readonly sample: readonly string[];
}

export interface AuditCheckResult {
  readonly checkId: string;
  readonly severity: AuditSeverity;
  readonly findings: readonly AuditFinding[];
  /**
   * How many source documents the check actually READ.
   *
   * The vacuity floor, and the reason it is on the result rather than in a log
   * line: a check that scanned nothing returns no findings, which is
   * byte-identical to a check that scanned everything and found nothing. The
   * runner refuses a check reporting zero scanned documents against a
   * collection that is not empty.
   */
  readonly documentsScanned: number;
}

export interface AuditCheck {
  readonly id: string;
  readonly severity: AuditSeverity;
  /** The CONVENTIONS.md section this check executes, so the two stay tied. */
  readonly conventionsSection: string;
  /**
   * Every collection this check reads, as a LITERAL.
   *
   * Never derived from a model name: a Mongoose collection name is an arbitrary
   * third argument, and a derivation over one is a check that cannot fail. The
   * runner asserts each of these EXISTS before the check runs, so a wrong
   * literal is a loud failure rather than a confident count of zero.
   */
  readonly collections: readonly string[];
  run(db: Db): Promise<AuditCheckResult>;
}
