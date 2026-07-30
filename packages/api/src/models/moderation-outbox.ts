import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * The durable record of moderation work that has to happen but has not happened
 * yet.
 *
 * This collection is the whole reason a 201 from `POST /reports` can be honest.
 * The report row and its delivery event commit in ONE transaction — not a call to
 * CrowdSource — so the user never waits for a third party to be reachable, and no
 * report is ever answered "received" with nothing that will send it.
 *
 * The same shape carries work in the other direction: a decision arriving over a
 * webhook is answered 2xx as soon as it is recorded here (§10.8) and applied
 * afterwards. **Nothing is enqueued that is not already written down.** If the
 * dispatcher, the process or the whole task disappears, every pending piece of
 * moderation work is re-derivable by reading this collection.
 */
export type ModerationOutboxKind = 'report.submit' | 'decision.apply';

/**
 * `dead_letter` is where retrying stops.
 *
 * Every error `@oxyhq/crowdsource` throws answers one question: could delivering
 * this same payload ever succeed. A 409 (§10.5's "external id reused with a
 * different body") or a rejected envelope cannot, so retrying forever would hide a
 * defect behind an ever-growing attempt count. Those events stop, keep their
 * error, and stay visible.
 */
export type ModerationOutboxStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'dead_letter';

export interface ModerationOutboxPayload {
  /** The local `Report._id`, for `report.submit`. */
  reportId?: string;
  /** The inbound webhook event id, for `decision.apply` (Appendix D). */
  eventId?: string;
  /** The CrowdSource case a decision belongs to. */
  caseId?: string;
  /**
   * The decision exactly as CrowdSource published it.
   *
   * Stored whole and opaque rather than projected into fields: §10.11 makes the
   * decision document loose, and a projection would silently drop whatever a newer
   * CrowdSource added — including a finding the enforcement mapping may later
   * need. It is validated against the published contract when it is READ, so an
   * event is never lost to a schema this deployment has not caught up with.
   */
  decision?: unknown;
}

export interface IModerationOutbox extends Document<string> {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  status: ModerationOutboxStatus;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  processedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Retention ceiling, so a stalled dispatcher cannot turn the outbox into an
 * unbounded collection. Long, because a moderation case can legitimately sit open
 * for weeks and a `dead_letter` event is evidence somebody still has to look at.
 * Operational alerts must fire long before this deadline.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const ModerationOutboxSchema = new Schema<IModerationOutbox>(
  {
    /**
     * The event id IS the idempotency key, and it is derived from the domain
     * object rather than generated. A transaction retry or two concurrent
     * duplicate submissions upsert the SAME row instead of queueing two
     * deliveries.
     */
    _id: { type: String, required: true },
    kind: {
      type: String,
      enum: ['report.submit', 'decision.apply'],
      required: true,
    },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'processed', 'dead_letter'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, required: true },
    leaseOwner: { type: String },
    leaseUntil: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    processedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false },
);

/** The dispatcher's claim query: due work, oldest first. */
ModerationOutboxSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
/** Reclaiming a dead worker's lease. */
ModerationOutboxSchema.index({ status: 1, leaseUntil: 1 });
ModerationOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationOutbox: Model<IModerationOutbox> =
  mongoose.models.ModerationOutbox ||
  mongoose.model<IModerationOutbox>('ModerationOutbox', ModerationOutboxSchema, 'moderation_outbox');
