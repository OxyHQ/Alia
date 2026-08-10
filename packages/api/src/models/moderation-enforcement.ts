import mongoose, { Document, Model, Schema } from 'mongoose';
import type { ModerationEnforcementMode } from '../lib/crowdsource/config.js';
import { MODERATION_ENFORCEMENT_ACTIONS, ModerationEnforcementAction } from '../value-sets/moderation-enforcement.js';

/**
 * What Alia did about a decision, once per decision revision per action.
 *
 * Appendix D's idempotency key is `decisionId + revision + action`, and the unique
 * compound index below IS that key. Every action CLAIMS its row before doing
 * anything, so a redelivered webhook, a reclaimed outbox lease or a manual replay
 * loses the insert and does nothing.
 *
 * `revision` is part of the key rather than a field beside it, and removing it
 * would be a silent, serious bug: a correction's `restore` is a DIFFERENT action
 * from the removal it supersedes, and collapsing them means an accepted appeal can
 * never put an agent back in the catalog.
 *
 * Every state-changing action records what the state WAS, so a reversal restores
 * the real previous value rather than a guess at one — a draft agent that was
 * somehow restricted must not be published by a correction.
 */

/**
 * The fields an action replaced, so a reversal can put them back.
 *
 * Flat and explicit rather than a `Mixed` blob: a reversal reads these, and a
 * shape nobody can typecheck is a shape that silently stops being restored.
 */
export interface ModerationPreviousState {
  isPublished?: boolean;
  isFeatured?: boolean;
  isTrending?: boolean;
  hiddenByModeration?: boolean;
}

export interface IModerationEnforcement extends Document {
  decisionId: string;
  decisionRevision: number;
  action: ModerationEnforcementAction;
  caseId: string;
  /** Alia's own noun (`agent`, `agent_review`, `skill`). */
  subjectType: string;
  subjectId: string;
  outcome: string;
  /** The CrowdSource recommendation this came from, when it came from one. */
  recommendedAction?: string;
  /** Why, in words an operator reads. Never reported material. */
  reason: string;
  mode: ModerationEnforcementMode;
  applied: boolean;
  appliedAt?: Date;
  /** Why a claimed action was deliberately not carried out. */
  skippedReason?: string;
  previousState?: ModerationPreviousState;
  createdAt: Date;
  updatedAt: Date;
}

const ModerationEnforcementSchema = new Schema<IModerationEnforcement>(
  {
    decisionId: { type: String, required: true },
    decisionRevision: { type: Number, required: true },
    action: {
      type: String,
      enum: MODERATION_ENFORCEMENT_ACTIONS,
      required: true,
    },
    caseId: { type: String, required: true, index: true },
    subjectType: { type: String, required: true },
    subjectId: { type: String, required: true },
    outcome: { type: String, required: true },
    recommendedAction: { type: String },
    reason: { type: String, required: true, maxlength: 500 },
    mode: {
      type: String,
      enum: ['observe', 'manual', 'automatic'],
      required: true,
    },
    applied: { type: Boolean, default: false },
    appliedAt: { type: Date },
    skippedReason: { type: String, maxlength: 500 },
    previousState: {
      type: new Schema<ModerationPreviousState>(
        {
          isPublished: { type: Boolean },
          isFeatured: { type: Boolean },
          isTrending: { type: Boolean },
          hiddenByModeration: { type: Boolean },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

/** Appendix D. This index is the idempotency guarantee, not an optimisation. */
ModerationEnforcementSchema.index(
  { decisionId: 1, decisionRevision: 1, action: 1 },
  { unique: true },
);
/** A reversal's lookup: the most recent applied action of a kind on a subject. */
ModerationEnforcementSchema.index({
  subjectType: 1,
  subjectId: 1,
  action: 1,
  applied: 1,
  createdAt: -1,
});

export const ModerationEnforcement: Model<IModerationEnforcement> =
  mongoose.models.ModerationEnforcement ||
  mongoose.model<IModerationEnforcement>(
    'ModerationEnforcement',
    ModerationEnforcementSchema,
    'moderation_enforcements',
  );
