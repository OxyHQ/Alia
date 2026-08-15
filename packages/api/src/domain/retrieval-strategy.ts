/**
 * Closed value sets for `retrieval-strategy`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
 */

export const AUTONOMY_INTENTS = [
  'meeting_prep',
  'inbox_digest',
  'project_status',
  'task_followup',
  'monitoring',
  'research',
  'general',
] as const;
export type AutonomyIntent = (typeof AUTONOMY_INTENTS)[number];
