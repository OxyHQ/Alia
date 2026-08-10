import { createHash } from 'crypto';
import type { ReportInput } from '@oxyhq/crowdsource';
import { REPORT_TAXONOMY_VERSION, allegationsForCategories } from './report-taxonomy.js';
import { subjectProviderFor } from './subjects/registry.js';
import type { ModerationSubjectSnapshot } from './subjects/types.js';
import type { StoredReport } from '../../db/moderation/reportRepository.js';

/**
 * Turning a stored report into the thing the SDK delivers.
 *
 * What this module produces is the SDK's `ReportInput` — a description of the
 * material — and the SDK derives the envelope from it: resource ids, relations,
 * digests, pseudonymous principal refs, the identity binding proof, the pinned
 * policy version, the privacy terms and the idempotency key.
 *
 * That is not a technicality. Those derived values are exactly what §7.3's dedup
 * key is computed over, so an application that composed its own envelope would be
 * the reason two reporters about one agent opened two cases — and "one penalty per
 * incident" would fail in production with nothing failing in a test. Building the
 * description and letting the SDK build the document is what keeps that property
 * true for every application at once.
 *
 * So this module does three things and no more: ask the registry for a snapshot of
 * the reported object, translate the reporter's categories into allegations, and
 * assemble both with the report's own identity.
 *
 * **Nothing composed here may vary between two deliveries of the same report.**
 * Ingress fingerprints the whole envelope to detect §10.5's payload conflict, so
 * an invented timestamp, a random id or an unsorted list turns a legitimate outbox
 * retry into a permanent 409 — silently, days later, as a report stuck in a queue.
 * Hence `submittedAt` is the report's own `createdAt`, allegation codes are sorted,
 * and category metadata is sorted before it is joined.
 */

/**
 * The material could not be described, because nothing can describe it.
 *
 * This is a DEFECT, not a state, and it should be unreachable. A report whose type
 * has no subject provider never gets a delivery event in the first place — intake
 * decides that from the same registry this module reads — so an event that arrives
 * here has been created by something that bypassed intake, or by a deployment
 * where a provider was removed while its reports were still in flight.
 *
 * `retryable: false` therefore dead-letters the outbox event so a human looks. The
 * alternative — writing a local state — would file a genuine defect in the one
 * place that looks identical to the deliberate local-only reports, where nothing
 * would ever alert on it.
 *
 * Separate from "the object is gone": a deleted object is a fact about the world
 * and closes the report normally.
 */
export class ModerationSubjectUnsupportedError extends Error {
  readonly retryable = false;

  constructor(reportedType: string) {
    super(`No moderation subject provider is registered for '${reportedType}'.`);
    this.name = 'ModerationSubjectUnsupportedError';
  }
}

/**
 * SHA-256 of the snapshot, stored on the report (§5.6).
 *
 * Taken over the described MATERIAL, not over the whole `ReportInput`: the report
 * id, the reporter and the allegations are properties of the report, and including
 * them would mean two people reporting identical content produced different hashes
 * — which is the opposite of what this hash is for. Key order is fixed by the
 * literal below rather than by `Object.keys`, so the digest is stable across Node
 * versions and across a refactor that reorders a field.
 */
export function snapshotHash(snapshot: ModerationSubjectSnapshot): string {
  const canonical = JSON.stringify({
    subject: {
      externalId: snapshot.subject.externalId,
      type: snapshot.subject.type,
      author: snapshot.subject.author?.oxyUserId ?? null,
    },
    content: snapshot.content,
    attachments: snapshot.attachments ?? [],
    context: snapshot.context ?? [],
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export interface ModerationReportInput {
  /** What the SDK delivers. */
  readonly reportInput: ReportInput;
  /** The digest to store on the local report. */
  readonly snapshotHash: string;
}

/**
 * Describe a stored report for delivery, or report why it cannot be described.
 *
 * Returns `null` when the reported object no longer exists, or when the provider
 * declines it (a built-in skill is not somebody's published work — see
 * `subjects/skill-subject.ts`). Neither is an error: content deleted between the
 * report and its delivery is ordinary, and a report about Alia's own seeded
 * content is a support question rather than a case.
 */
export async function buildModerationReportInput(
  report: Pick<
    StoredReport,
    'id' | 'reportedType' | 'reportedId' | 'reporter' | 'categories' | 'details' | 'createdAt'
  >,
): Promise<ModerationReportInput | null> {
  const provider = subjectProviderFor(report.reportedType);
  if (!provider) throw new ModerationSubjectUnsupportedError(report.reportedType);

  const snapshot = await provider.snapshot(report.reportedId);
  if (!snapshot) return null;

  const allegationCodes = allegationsForCategories(report.categories);
  const details = report.details?.trim();

  return {
    reportInput: {
      externalReportId: report.id,
      subject: snapshot.subject,
      content: snapshot.content,
      ...(snapshot.attachments === undefined
        ? {}
        : { attachments: snapshot.attachments }),
      ...(snapshot.context === undefined ? {} : { context: snapshot.context }),
      /**
       * The reporter's own words ride on the FIRST allegation only.
       *
       * Repeating one free-text field across every code would say the reporter
       * wrote it about each of them separately, and §6.2 is explicit that details
       * are the reporter's claim and never evidence for it.
       */
      allegations: allegationCodes.map((code, index) =>
        index === 0 && details ? { code, details } : { code },
      ),
      /**
       * The Oxy subject IS the binding proof (§11.14). Alia stores reporters as
       * Oxy user ids, so there is no separate binding step to implement here.
       */
      reportedBy: { oxyUserId: report.reporter },
      /**
       * The moment the USER reported it — the local report's own timestamp, not
       * the moment of delivery. Any value invented per attempt would make every
       * retry from the outbox a permanent 409 (§10.5).
       */
      submittedAt: report.createdAt,
      metadata: {
        /** So a case can be read back against the mapping that produced it. */
        aliaTaxonomyVersion: REPORT_TAXONOMY_VERSION,
        aliaCategories: [...report.categories].sort().join(','),
        /**
         * Declared, because it cannot yet be attached. An agent's avatar is a bare
         * string with no digest recorded anywhere — see `subjects/agent-subject.ts`
         * — so a jury that can see material exists which it was not given can
         * answer `insufficient_context` for the right reason.
         */
        evidenceAttachmentsSupported: false,
      },
    },
    snapshotHash: snapshotHash(snapshot),
  };
}
