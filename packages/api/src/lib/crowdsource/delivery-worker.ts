import {
  closeUndeliverableReport,
  findReportById,
  markReportDeliveryFailed,
  markReportSubmitted,
} from '../../db/moderation/reportRepository.js';
import type { ModerationOutboxEvent } from '../../db/moderation/outboxRepository.js';
import { getCrowdSourceClient } from './client.js';
import { buildModerationReportInput } from './evidence-snapshot.js';
import { log } from '../logger.js';
import { recordMetric } from '../observability/index.js';

/**
 * Delivering a stored report to CrowdSource.
 *
 * Everything hard about this is handled elsewhere and the shape of this file is
 * what is left over: the SDK owns the envelope, the idempotency key, the timeouts,
 * the per-attempt retries and the classification of failures; the outbox owns
 * durability, backoff and dead-lettering. What remains is to describe the
 * material, hand it over, and write down what came back.
 *
 * The failures are as important as the success:
 *
 * - **Nowhere to send it.** The integration is not configured. The event stays
 *   pending, untouched, and delivers when it is — a delay, never a loss.
 * - **The object is gone, or is not somebody's published work.** Deleted between
 *   the report and its delivery, or a built-in skill. There is nothing for a jury
 *   to review, so the report closes locally instead of retrying for days.
 * - **The type has no provider.** Unreachable by design — such a report never gets
 *   a delivery event — so an event that reaches it is a defect and is dead-lettered
 *   rather than retried or filed as a state.
 * - **Anything else** is the SDK's `retryable` to answer, and the outbox obeys it.
 */

/** Thrown when there is nowhere to deliver to yet. Always retryable. */
export class CrowdSourceUnavailableError extends Error {
  readonly retryable = true;

  constructor() {
    super('The CrowdSource integration is not configured in this deployment.');
    this.name = 'CrowdSourceUnavailableError';
  }
}

/**
 * A delivery event that cannot become deliverable.
 *
 * `retryable: false` is the field the outbox reads to dead-letter instead of
 * backing off — the same contract every error from `@oxyhq/crowdsource` answers.
 */
export class ModerationDeliveryRejectedError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDeliveryRejectedError';
  }
}

/** Handle one `report.submit` outbox event. */
export async function deliverReportOutboxEvent(
  event: ModerationOutboxEvent,
): Promise<void> {
  const reportId = event.payload.reportId;
  if (reportId === undefined) {
    throw new ModerationDeliveryRejectedError('A report.submit event carried no reportId.');
  }

  const report = await findReportById(reportId);
  if (!report) {
    /**
     * The report is gone but its delivery event survived. Nothing to deliver and
     * nothing to fix, so the event completes — retrying would keep looking for a
     * row that no longer exists.
     */
    log.general.warn({ reportId }, '[CrowdSource] delivery event has no report');
    return;
  }

  const crowdsource = getCrowdSourceClient();
  if (!crowdsource) throw new CrowdSourceUnavailableError();

  /**
   * A `ModerationSubjectUnsupportedError` from here is NOT caught. It carries
   * `retryable: false`, so the outbox dead-letters the event — which is the right
   * channel for a defect that needs a human. Catching it and writing a local state
   * would put the report somewhere nothing alerts on.
   */
  const input = await buildModerationReportInput({
    id: report.id,
    reportedType: report.reportedType,
    reportedId: report.reportedId,
    reporter: report.reporter,
    categories: report.categories,
    details: report.details,
    createdAt: report.createdAt,
  });

  if (input === null) {
    await closeUndeliverableReport(
      reportId,
      'The reported content is no longer available for review, so there is nothing to review.',
    );
    recordMetric({
      name: 'crowdsource_report_delivery_total',
      value: 1,
      labels: { result: 'content_unavailable' },
    });
    return;
  }

  let receipt: Awaited<ReturnType<typeof crowdsource.reports.create>>;
  try {
    receipt = await crowdsource.reports.create(input.reportInput);
  } catch (error: unknown) {
    /**
     * The failure is visible on the report itself, not only in the outbox row.
     * `delivery_failed` is what a reporter's receipt and any operational sweep both
     * read; leaving the report at `queued` while the outbox quietly backed off
     * would hide the problem in a collection nobody looks at. Written before
     * rethrowing so the outbox still applies its own backoff or dead-letters the
     * event.
     */
    await markReportDeliveryFailed(
      reportId,
      error instanceof Error ? error.message : String(error),
    );
    recordMetric({
      name: 'crowdsource_report_delivery_total',
      value: 1,
      labels: { result: 'failed' },
    });
    throw error;
  }

  await markReportSubmitted(reportId, {
    crowdSourceReportId: receipt.reportId,
    crowdSourceCaseId: receipt.caseId,
    crowdSourceMerged: receipt.merged,
    contentSnapshotHash: input.snapshotHash,
  });

  recordMetric({
    name: 'crowdsource_report_delivery_total',
    value: 1,
    labels: { result: receipt.merged ? 'merged' : 'delivered' },
  });
  log.general.info(
    { reportId, caseId: receipt.caseId, merged: receipt.merged },
    '[CrowdSource] report delivered',
  );
}
