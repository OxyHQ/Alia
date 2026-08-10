/**
 * What Alia does to its own catalogue when a jury decides.
 *
 * A CLOSED VALUE SET, declared here rather than in the Mongoose model that used
 * to own it. Both stores read this one tuple: the model's `enum` validator and
 * the Postgres CHECK `db/schema` renders. A second copy can disagree with the
 * first, and the disagreement is invisible until a write hits one and not the
 * other.
 *
 * It lives outside `models/` because `db/schema` imports it as a RUNTIME value,
 * so the schema — and every migration's CHECK — would otherwise depend on a
 * Mongoose model the port is retiring. See `db/schema/CONVENTIONS.md`
 * ("Closed value sets").
 */

/**
 * The three things Alia can actually do to a published artefact, reversibly, plus
 * the two that are notes rather than effects.
 *
 * Deliberately NOT a copy of another application's vocabulary. There is no
 * `label_sensitive` here because Alia renders no content warning anywhere, and
 * recording an effect that did not happen would be worse than mapping honestly —
 * see `lib/crowdsource/enforcement-plan.ts`.
 */
export type ModerationEnforcementAction =
  /** Take the artefact out of the catalog. Only its owner can still see it. */
  | 'restrict'
  /** Undo everything moderation previously did to this subject. */
  | 'restore'
  /** Remove editorial promotion (featured / trending) without unpublishing. */
  | 'demote'
  /** Recorded for a human. Never executed automatically. */
  | 'manual_review'
  /** An explicit, recorded decision to do nothing. */
  | 'none';

export const MODERATION_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  'restrict',
  'restore',
  'demote',
  'manual_review',
  'none',
];
