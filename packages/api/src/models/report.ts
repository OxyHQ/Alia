import mongoose, { Document, Model, Schema } from 'mongoose';
import { MODERATION_LOCAL_STATUSES, ModerationLocalStatus, ReportCategory, ReportStatus, ReportedType } from '../domain/report.js';

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
