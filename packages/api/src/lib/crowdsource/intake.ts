import { uuidv7 } from '@oxyhq/db';
import { getDb } from '../../db/index.js';
import {
  createReport as storeReport,
  type StoredReport,
} from '../../db/moderation/reportRepository.js';
import { reportSubmitEventId } from '../../db/moderation/outboxRepository.js';
import { ReportCategory, ReportedType } from '../../domain/report.js';
import { subjectProviderFor } from './subjects/registry.js';

/**
 * Storing a report and, when there is somewhere to send it, the promise to deliver
 * it — in one operation.
 *
 * This is the only thing in the integration that a user waits for. A 201 from
 * `POST /reports` means the report row and its outbox event committed together. It
 * does NOT mean CrowdSource accepted anything — CrowdSource may be unreachable,
 * mid-deploy or not yet configured, and the reporter is told their report was
 * received either way, because it was.
 *
 * The transaction is the whole mechanism. Two writes outside one would give two
 * failure modes that are both silent: a report with no delivery event (the report
 * exists, nothing will ever send it, and nobody finds out until somebody asks why
 * a case never opened) or a delivery event with no report (a worker looking up an
 * id that was rolled back). Neither surfaces as an error at the moment it happens,
 * which is exactly why this has to be atomic rather than carefully ordered.
 *
 * **On Postgres the transaction is no longer conditional on the deployment.**
 * Under Mongo this needed a replica set, so `topology.ts` checked for one at boot
 * and the dispatcher refused to run without it — a standalone `mongod` accepted
 * every other write Alia made and failed only here. Postgres has no such mode, so
 * the check and its "there is deliberately no non-transactional fallback" warning
 * are gone with it: there is nothing left to fall back FROM.
 *
 * The one report with NO delivery event is the one whose type has no subject
 * provider, and that is a different claim entirely: not "delivery failed" but
 * "there was never a route out of this application for this kind of object". Those
 * two must not be conflated, which is why they are different `localStatus` values
 * and why the absent route is written down as a reason rather than inferred from a
 * missing row.
 */

export class DuplicateReportError extends Error {
  readonly existing: StoredReport;

  constructor(existing: StoredReport) {
    super('This item has already been reported by this reporter.');
    this.name = 'DuplicateReportError';
    this.existing = existing;
  }
}

/**
 * Refuses an identifier that is not a string, at the point the WRITE is built.
 *
 * `CreateReportInput` types these as strings and the route rejects a missing one,
 * but a type is erased at runtime. Under Mongo the specific hazard was an operator
 * object (`{$ne: null}`) reaching a `findOne` filter and matching an unrelated
 * report; parameterised SQL cannot be subverted that way, but a non-string still
 * has no business being stored in an identifier column, and the unique key that
 * decides duplicates is built from these three values.
 *
 * The check lives here rather than at the route because `createReport` is
 * exported: a queue worker, a reconciliation script or a future admin path is
 * under no obligation to have passed the route's validation, and a guard that only
 * exists at one caller is a guard that holds until the second one arrives.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`createReport: '${field}' must be a non-empty string.`);
  }
  return value;
}

/**
 * Narrows a checked string to the enum.
 *
 * A type predicate rather than a cast, so the runtime check and the compile-time
 * claim are the same statement. A cast would keep compiling if a value were
 * removed from `ReportedType`, which is exactly when the check matters.
 */
function isReportedType(value: string): value is ReportedType {
  return (Object.values(ReportedType) as string[]).includes(value);
}

export interface CreateReportInput {
  reporter: string;
  reportedType: ReportedType;
  reportedId: string;
  categories: ReportCategory[];
  details?: string;
}

export interface CreateReportResult {
  report: StoredReport;
  /**
   * The durable delivery event.
   *
   * Absent exactly when the reported type has no subject provider — the report was
   * stored and there is nothing to deliver it, by design rather than by failure.
   */
  outboxEventId?: string;
}

/**
 * Why a report is not going anywhere, in words an operator can read.
 *
 * Stored on the row rather than left to be inferred from a missing outbox event. A
 * missing row is also what a lost write looks like, and the two need to be
 * distinguishable months later without re-deriving which types had providers at
 * the time.
 */
function localOnlyReason(reportedType: string): string {
  return (
    `Alia has no moderation subject provider for '${reportedType}', so this report is ` +
    'recorded locally and is not sent for community review.'
  );
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Delivery is queued when — and only when — the reported type has a subject
 * provider. A type without one is stored at `received` with the reason recorded,
 * which is a real state rather than a failure.
 *
 * That branch is the reason the two writes stay in one transaction rather than
 * being ordered carefully. The condition is read BEFORE the transaction body
 * decides anything, so `localStatus` and the presence of an outbox row are decided
 * together from one fact — a report can never commit as `queued` with nothing to
 * deliver it, nor as `received` with a delivery event that will try anyway.
 *
 * **The id is minted here, not by the database.** `reports.id` has no default, and
 * that is what this function needs: `reportSubmitEventId(reportId)` has to be
 * known BEFORE the insert so both rows can be written in one pass. Mongo got the
 * same property from a client-generated `ObjectId`.
 *
 * Intake deliberately does not read `CROWDSOURCE_ENABLED`. A report taken while
 * the integration is off still gets its delivery event, so turning the flag on
 * delivers the backlog instead of stranding it — the dispatcher is what is gated,
 * not the durable record. Nothing here is conditional on a third party's state;
 * only on whether this application knows how to describe the object at all.
 */
export async function createReport(
  input: CreateReportInput,
): Promise<CreateReportResult> {
  const reporter = requireIdentifier(input.reporter, 'reporter');
  const reportedId = requireIdentifier(input.reportedId, 'reportedId');
  const reportedTypeValue = requireIdentifier(input.reportedType, 'reportedType');
  if (!isReportedType(reportedTypeValue)) {
    throw new TypeError(
      `createReport: reportedType '${reportedTypeValue}' is not a reportable type.`,
    );
  }
  const reportedType: ReportedType = reportedTypeValue;
  if (!Array.isArray(input.categories) || input.categories.length === 0) {
    throw new TypeError('createReport: at least one category is required.');
  }
  const deliverable = subjectProviderFor(reportedType) !== undefined;

  const id = uuidv7();
  const result = await storeReport(
    getDb(),
    {
      id,
      reportedType,
      reportedId,
      reporter,
      categories: input.categories,
      details: input.details,
      localStatus: deliverable ? 'queued' : 'received',
      ...(deliverable ? {} : { localStatusReason: localOnlyReason(reportedType) }),
    },
    deliverable
      ? {
          eventId: reportSubmitEventId(id),
          kind: 'report.submit',
          payload: { reportId: id },
        }
      : null,
  );

  if (!result.created) throw new DuplicateReportError(result.existing);
  return deliverable
    ? { report: result.report, outboxEventId: reportSubmitEventId(id) }
    : { report: result.report };
}
