/**
 * CrowdSource moderation: reports, the delivery outbox, inbound event claims and
 * enforcement records.
 *
 * Four tables, ported early on purpose. This is the only domain in the service
 * carrying multi-document TRANSACTIONS, and the surface is small enough that
 * getting the hard mechanics right costs little now and a great deal after sixty
 * other tables have landed around it. Two of its guarantees do not survive a
 * naive port and are called out where they live:
 *
 *  - a report and its delivery event commit together, or neither does;
 *  - a duplicate report is answered with the EXISTING report, which on Postgres
 *    needs a SAVEPOINT — see `db/moderation/reportRepository.ts`.
 *
 * The value tuples are imported from `domain/`, never retyped here, so the CHECK
 * and the TypeScript union cannot drift. They were read off the Mongoose models
 * while both stores existed and moved to `domain/` when those were deleted —
 * one definition throughout, at no point duplicated.
 */

import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';
import { checkArrayWithin, checkOneOf } from './columns';
import { MODERATION_ENFORCEMENT_ACTIONS } from '../../domain/moderation-enforcement.js';
import { MODERATION_LOCAL_STATUSES, ReportCategory, ReportStatus, ReportedType } from '../../domain/report.js';

const REPORTED_TYPES = Object.values(ReportedType);
const REPORT_CATEGORIES = Object.values(ReportCategory);
const REPORT_STATUSES = Object.values(ReportStatus);
export const MODERATION_OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;
export const MODERATION_OUTBOX_STATUSES = ['pending', 'processing', 'processed', 'dead_letter'] as const;
export const MODERATION_EVENT_STATES = ['claimed', 'queued', 'ignored'] as const;
export const MODERATION_ENFORCEMENT_MODES = ['observe', 'manual', 'automatic'] as const;

/**
 * An abuse report.
 *
 * `UNIQUE(reporter, reported_type, reported_id)` is what makes a repeat
 * submission converge instead of creating a second case. Under Mongo the service
 * ALSO did a `findOne` first and threw with the existing document — a read that
 * only narrowed the race the index already closed. The Postgres port drops the
 * pre-check and handles the unique violation, which is both race-free and the
 * reason the recovery read needs a savepoint.
 *
 * `categories` is `text[]`, not a child table: it is a small unordered set read
 * whole with the report and never addressed on its own. Its members are CHECKed
 * against the same tuple that types them — an array CHECK has to be written as a
 * containment test rather than `in (…)`, which is why it is spelled out below
 * rather than going through `checkOneOf`.
 */
export const reports = pgTable(
  'reports',
  {
    /** Mongo `_id`, preserved verbatim — CrowdSource holds these ids. */
    id: text().primaryKey(),
    reportedType: text({ enum: REPORTED_TYPES as [string, ...string[]] }).notNull(),
    reportedId: text().notNull(),
    reporter: text().notNull(),
    /**
     * Typed with the tuple as well as CHECKed against it, so a row READ back
     * carries `ReportCategory[]` rather than `string[]`. `text({enum})` emits no
     * DDL, so this costs nothing in the migration and buys the delivery path its
     * types: `allegationsForCategories` takes the union, and without this every
     * reader would need a cast asserting exactly what the CHECK already enforces.
     */
    categories: text({ enum: REPORT_CATEGORIES as [ReportCategory, ...ReportCategory[]] })
      .array()
      .notNull(),
    details: text(),
    status: text({ enum: REPORT_STATUSES as [string, ...string[]] }).notNull().default(ReportStatus.PENDING),
    localStatus: text({ enum: MODERATION_LOCAL_STATUSES as [string, ...string[]] }).notNull().default('received'),
    localStatusReason: text(),
    lastDeliveryError: text(),
    crowdSourceReportId: text(),
    crowdSourceCaseId: text(),
    crowdSourceMerged: boolean(),
    contentSnapshotHash: text(),
    submittedAt: timestamptz(),
    decisionId: text(),
    decisionRevision: integer(),
    /**
     * What the jury concluded, and what Alia did about it.
     *
     * `decisionOutcome` and `decisionStatus` are plain `text` with NO CHECK, and
     * that is deliberate rather than an omission. Both arrive from CrowdSource,
     * and §10.11 makes a decision document loose ON PURPOSE so that an event this
     * deployment does not recognise yet WAITS in the outbox until the code
     * catches up. A CHECK rendered from a tuple this repository owns would invert
     * that: the day CrowdSource adds a status, a real decision would fail its
     * write and dead-letter. The value is recorded as delivered and interpreted
     * where it is read — `report-status.ts` matches the known values explicitly
     * and maps everything else to `reviewed`, which is where an unknown belongs.
     *
     * `enforcedAction` is the opposite case and so is constrained: it is ALIA's
     * own closed set, written only by `primaryAction()`, which can return nothing
     * but a member of `MODERATION_ENFORCEMENT_ACTIONS`.
     */
    decisionOutcome: text(),
    decisionStatus: text(),
    decidedAt: timestamptz(),
    enforcedAction: text({ enum: MODERATION_ENFORCEMENT_ACTIONS as [string, ...string[]] }),
    enforcedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reports_reporter_type_id_key').on(t.reporter, t.reportedType, t.reportedId),
    index('reports_local_status_created_at_idx').on(t.localStatus, t.createdAt),
    index('reports_crowdsource_case_id_idx').on(t.crowdSourceCaseId),
    index('reports_reporter_idx').on(t.reporter),
    checkOneOf('reports_reported_type_check', t.reportedType, REPORTED_TYPES),
    checkOneOf('reports_status_check', t.status, REPORT_STATUSES),
    checkOneOf('reports_local_status_check', t.localStatus, MODERATION_LOCAL_STATUSES),
    checkOneOf('reports_enforced_action_check', t.enforcedAction, MODERATION_ENFORCEMENT_ACTIONS),
    checkArrayWithin('reports_categories_check', t.categories, REPORT_CATEGORIES),
    // Cardinality, kept separate from membership: containment permits `{}`, and
    // a report with no allegation is not a report. Mongoose expressed this as a
    // custom validator, which did not run on updateOne at all.
    //
    // `cardinality`, NOT `array_length(col, 1)`. On an EMPTY array
    // `array_length` returns NULL, `NULL >= 1` is NULL, and a CHECK rejects only
    // FALSE — so the obvious spelling admits exactly the value it exists to
    // forbid. Measured: the empty-list test passed against `array_length` and
    // fails against it no longer.
    check('reports_categories_not_empty_check', sql`cardinality(${t.categories}) >= 1`),
  ],
);

/**
 * The delivery queue. The ROW is the job.
 *
 * `id` is deterministic (derived from the report and the event kind), so an
 * enqueue that runs twice converges on one row rather than queueing two
 * deliveries. That is why the enqueue is `ON CONFLICT DO NOTHING` and NOT
 * `DO UPDATE`: a repeat must be a genuine no-op, writing no tuple version and
 * touching no timestamp, because the dispatcher may be holding a lease on that
 * very row at the time.
 *
 * TTL: `expireAfterSeconds: 0` on `expires_at`. **This table can hold
 * UNPROCESSED WORK**, and `expires_at` is set at insert and never advanced — so
 * a row that never reaches a terminal state leaves after its deadline whether or
 * not it was ever delivered. That is deliberate (a job stuck that long is not
 * going to succeed) but it means a dispatcher down for the whole window loses
 * its backlog silently. `reports_local_status_created_at_idx` is what surfaces
 * it: reports stuck in `queued` are still there after their outbox rows are gone.
 */
export const moderationOutboxes = pgTable(
  'moderation_outboxes',
  {
    id: text().primaryKey(),
    kind: text({ enum: MODERATION_OUTBOX_KINDS }).notNull(),
    /** The delivery envelope. Shape belongs to the CrowdSource contract. */
    payload: jsonb().notNull(),
    status: text({ enum: MODERATION_OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The claim query's index: pending rows whose time has come, oldest first.
    index('moderation_outboxes_claim_idx').on(t.status, t.availableAt, t.createdAt),
    // Reclaiming a dead task's expired lease.
    index('moderation_outboxes_lease_idx').on(t.status, t.leaseUntil),
    index('moderation_outboxes_expires_at_idx').on(t.expiresAt),
    checkOneOf('moderation_outboxes_kind_check', t.kind, MODERATION_OUTBOX_KINDS),
    checkOneOf('moderation_outboxes_status_check', t.status, MODERATION_OUTBOX_STATUSES),
  ],
);

/**
 * Inbound webhook deduplication.
 *
 * The primary key IS the provider's event id, so the claim is an
 * `INSERT … ON CONFLICT (id) DO NOTHING … RETURNING`: an empty result set means
 * somebody already claimed it. The conflict is NOT an error to catch — reading
 * it as one would swallow a genuine failure (a dropped connection, an exhausted
 * pool) as "duplicate".
 *
 * Postgres-backed rather than in-process because this service runs several ECS
 * tasks, and an in-memory set only dedupes the task that received both copies.
 *
 * TTL: `expireAfterSeconds: 0` on `expires_at`. The claim must outlive every
 * redelivery of its event and nothing after; the row's only content is its own
 * id, so deleting an expired one is exactly the intent.
 */
export const moderationEvents = pgTable(
  'moderation_events',
  {
    id: text().primaryKey(),
    type: text(),
    caseId: text(),
    payload: jsonb(),
    state: text({ enum: MODERATION_EVENT_STATES }).notNull().default('claimed'),
    receivedAt: timestamptz().notNull(),
    queuedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('moderation_events_case_id_idx').on(t.caseId),
    index('moderation_events_expires_at_idx').on(t.expiresAt),
    checkOneOf('moderation_events_state_check', t.state, MODERATION_EVENT_STATES),
  ],
);

/**
 * What Alia did about a decision.
 *
 * `UNIQUE(decision_id, decision_revision, action)` is the idempotency key, and
 * `decision_revision` being IN it is load-bearing: drop it and a correction's
 * `restore` becomes the same row as the `restrict` it supersedes, so an accepted
 * appeal could never relist the item.
 *
 * `previous_state` is `jsonb` and nullable. It captures the subject's real state
 * before a restriction so the restore can put it back, and its shape varies by
 * subject type — a listing's flags are not a review's. Nullable because
 * `observe` mode records the plan without touching anything, so there is nothing
 * to remember.
 */
export const moderationEnforcements = pgTable(
  'moderation_enforcements',
  {
    id: text().primaryKey(),
    decisionId: text().notNull(),
    decisionRevision: integer().notNull(),
    action: text({ enum: MODERATION_ENFORCEMENT_ACTIONS as [string, ...string[]] }).notNull(),
    caseId: text().notNull(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    outcome: text().notNull(),
    recommendedAction: text(),
    reason: text().notNull(),
    mode: text({ enum: MODERATION_ENFORCEMENT_MODES }).notNull(),
    applied: boolean().notNull().default(false),
    appliedAt: timestamptz(),
    skippedReason: text(),
    previousState: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('moderation_enforcements_decision_revision_action_key').on(
      t.decisionId,
      t.decisionRevision,
      t.action,
    ),
    index('moderation_enforcements_case_id_idx').on(t.caseId),
    /**
     * The REVERSAL's lookup: the most recent APPLIED action of a kind against a
     * subject, which is what lets `restore` put back the value that was actually
     * there instead of guessing one.
     *
     * Present in the Mongo model and missing here until the enforcement port —
     * the kind of omission nothing catches, because a sequential scan over a
     * small table returns exactly the right row. It only ever shows up as a slow
     * query years later, on the path a correction takes.
     */
    index('moderation_enforcements_subject_applied_idx').on(
      t.subjectType,
      t.subjectId,
      t.action,
      t.applied,
      t.createdAt.desc(),
    ),
    checkOneOf('moderation_enforcements_action_check', t.action, MODERATION_ENFORCEMENT_ACTIONS),
    checkOneOf('moderation_enforcements_mode_check', t.mode, MODERATION_ENFORCEMENT_MODES),
  ],
);
