import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * Every webhook event CrowdSource has delivered, and what became of it.
 *
 * Two jobs in one collection, and both need it to be durable.
 *
 * **Deduplication.** `_id` is the event id and the index on it is unique, so
 * inserting the row IS the claim — the duplicate-key error is the answer
 * "somebody else already has this event", not a failure to work around. Alia runs
 * several ECS tasks behind one ALB, so the SDK's in-process default store would
 * deduplicate only the instance that happened to receive both copies of a
 * redelivery.
 *
 * **Audit.** "Did CrowdSource tell us about this case, and when" is the first
 * question asked when a report looks stuck, so an event carrying nothing to do is
 * still recorded rather than dropped.
 */

/**
 * `claimed` → `queued` | `ignored`.
 *
 * A row left at `claimed` means the handler neither queued work nor decided there
 * was none — it crashed. That is deliberately visible rather than tidied away.
 */
export type ModerationEventState = 'claimed' | 'queued' | 'ignored';

export interface IModerationEvent extends Document<string> {
  _id: string;
  type?: string;
  caseId?: string;
  /** The event as delivered. Opaque here, parsed by the worker that acts on it. */
  payload?: unknown;
  state: ModerationEventState;
  receivedAt: Date;
  queuedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Long enough to answer "was this event ever delivered" about a case that has
 * been open for months, and bounded so the collection cannot grow forever.
 */
export const MODERATION_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const ModerationEventSchema = new Schema<IModerationEvent>(
  {
    _id: { type: String, required: true },
    type: { type: String },
    caseId: { type: String, index: true },
    payload: { type: Schema.Types.Mixed },
    state: {
      type: String,
      enum: ['claimed', 'queued', 'ignored'],
      default: 'claimed',
      index: true,
    },
    receivedAt: { type: Date, required: true },
    queuedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false },
);

ModerationEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationEvent: Model<IModerationEvent> =
  mongoose.models.ModerationEvent ||
  mongoose.model<IModerationEvent>('ModerationEvent', ModerationEventSchema, 'moderation_events');
