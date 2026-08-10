/**
 * Closed value sets for `moderation-enforcement`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

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
