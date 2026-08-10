/**
 * Closed value sets for `retrieval-strategy`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
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
