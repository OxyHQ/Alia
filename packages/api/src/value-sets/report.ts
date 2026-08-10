/**
 * What may be reported, what the reporter alleges, and where the report is.
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
