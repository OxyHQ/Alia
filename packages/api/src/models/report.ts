import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * A report a user filed in Alia.
 *
 * Two status axes, because they answer two genuinely different questions and one
 * field cannot hold both. `localStatus` is where the report is in ALIA's pipeline
 * — stored, queued, delivered, failed, closed. `status` is what a jury concluded.
 * A report is routinely `submitted` with no verdict yet, and `closed` with a
 * verdict of `dismissed`; collapsing them would make "we delivered it" and "it was
 * fine" the same value.
 */

/**
 * What Alia will accept a report ABOUT.
 *
 * Wider than what it can deliver, and deliberately so — see
 * `lib/crowdsource/subjects/registry.ts`. A type with a subject provider is sent
 * for community review; a type without one is stored with the reason and never
 * leaves. Making this enum the delivery gate would mean every future report
 * surface breaks on the day it is added rather than degrading to what Alia did
 * before CrowdSource existed.
 */
export enum ReportedType {
  /** A published marketplace agent. */
  AGENT = 'agent',
  /** A user's written review of an agent. */
  AGENT_REVIEW = 'agent_review',
  /** A published community skill. */
  SKILL = 'skill',
  /**
   * An Alia account.
   *
   * Accepted, never delivered. Oxy owns identity — Alia stores only a
   * denormalized `authorName` alongside the objects a person publishes, so there
   * is no Alia-side profile for §5.6 to pin as "the exact version reported". The
   * material a jury would need belongs to a product that is not this one.
   */
  USER = 'user',
}

/**
 * What the reporter says is wrong.
 *
 * These are Alia's own words in Alia's own UI. The translation into §6.3's
 * universal allegation codes lives in `lib/crowdsource/report-taxonomy.ts` and is
 * versioned there.
 */
export enum ReportCategory {
  SPAM = 'spam',
  HARASSMENT = 'harassment',
  HATE_SPEECH = 'hate_speech',
  EXPLICIT_CONTENT = 'explicit_content',
  IMPERSONATION = 'impersonation',
  /** An agent or skill whose published instructions are built to cause harm. */
  MALICIOUS_INSTRUCTIONS = 'malicious_instructions',
  OTHER = 'other',
}

/** What a jury concluded. `PENDING` until one has. */
export enum ReportStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

/**
 * Where the report is in Alia's own pipeline.
 *
 * `received` and `delivery_failed` are NOT the same claim and must never be
 * merged. `received` means there was never a route out of this application for
 * this kind of object; `delivery_failed` means there is one and it did not work
 * this time. Only the second is worth retrying, and only the first is a
 * deliberate state.
 */
export type ModerationLocalStatus =
  | 'received'
  | 'queued'
  | 'submitted'
  | 'delivery_failed'
  | 'closed';

export const MODERATION_LOCAL_STATUSES: readonly ModerationLocalStatus[] = [
  'received',
  'queued',
  'submitted',
  'delivery_failed',
  'closed',
];

export interface IReport extends Document {
  /**
   * Declared explicitly because a bare `Document` types `_id` as `unknown`, and
   * every consumer here needs the hex string — the report id IS the
   * `externalReportId` the whole CrowdSource side is keyed on.
   */
  _id: mongoose.Types.ObjectId;
  reportedType: ReportedType;
  reportedId: string;
  /** The reporter's Oxy user id, which IS the §11.14 binding proof. */
  reporter: string;
  categories: ReportCategory[];
  details?: string;

  status: ReportStatus;
  localStatus: ModerationLocalStatus;
  /** Why the report is where it is, in words an operator can read. */
  localStatusReason?: string;
  lastDeliveryError?: string;

  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  crowdSourceMerged?: boolean;
  /** §5.6: the digest of the exact representation that was sent for review. */
  contentSnapshotHash?: string;
  submittedAt?: Date;

  decisionId?: string;
  decisionRevision?: number;
  decisionOutcome?: string;
  decisionStatus?: string;
  decidedAt?: Date;
  enforcedAction?: string;
  enforcedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    reportedType: {
      type: String,
      enum: Object.values(ReportedType),
      required: true,
      index: true,
    },
    /**
     * A String, not an ObjectId.
     *
     * Alia's own ids are ObjectIds but an Oxy user id is not guaranteed to be
     * one, and this value travels verbatim into the envelope's `reportedBy`.
     * Casting it through an ObjectId would either throw on a legitimate id or
     * silently change the value that a binding proof is checked against.
     */
    reportedId: { type: String, required: true },
    reporter: { type: String, required: true, index: true },
    categories: {
      type: [{ type: String, enum: Object.values(ReportCategory) }],
      required: true,
      validate: {
        validator: (categories: string[]) => categories.length > 0,
        message: 'A report must carry at least one category.',
      },
    },
    details: { type: String, maxlength: 2000 },

    status: {
      type: String,
      enum: Object.values(ReportStatus),
      default: ReportStatus.PENDING,
      index: true,
    },
    localStatus: {
      type: String,
      enum: MODERATION_LOCAL_STATUSES,
      default: 'received',
      index: true,
    },
    localStatusReason: { type: String, maxlength: 300 },
    lastDeliveryError: { type: String, maxlength: 2000 },

    crowdSourceReportId: { type: String },
    crowdSourceCaseId: { type: String, index: true },
    crowdSourceMerged: { type: Boolean },
    contentSnapshotHash: { type: String },
    submittedAt: { type: Date },

    decisionId: { type: String },
    decisionRevision: { type: Number },
    decisionOutcome: { type: String },
    decisionStatus: { type: String },
    decidedAt: { type: Date },
    enforcedAction: { type: String },
    enforcedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One report per reporter per object.
 *
 * A unique index rather than a check in the handler: two concurrent submissions
 * from the same client are the ordinary case (a double tap), and a read-then-write
 * leaves exactly the gap where the second one lands.
 */
ReportSchema.index({ reporter: 1, reportedType: 1, reportedId: 1 }, { unique: true });
/** The reconciliation sweep's query: what is still in flight, oldest first. */
ReportSchema.index({ localStatus: 1, createdAt: 1 });

export type LeanReport = Omit<IReport, keyof Document> & { _id: mongoose.Types.ObjectId };

export const Report: Model<IReport> =
  mongoose.models.Report || mongoose.model<IReport>('Report', ReportSchema);
