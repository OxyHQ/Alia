/**
 * Closed value sets for `agent-session`.
 *
 * These live in `domain/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and this module must stay a leaf that imports nothing.
 */

/**
 * The tuples the Postgres CHECKs render from. Exported rather than retyped, so
 * a constraint and the validator guarding the same column cannot drift.
 *
 * `EVENT_STREAM_ENTRY_TYPES` is IMPORTED, not redeclared: the embedded
 * `eventStream` array below and the `event_stream_entries` collection are the
 * same vocabulary, and they were two identical fourteen-value literals until
 * this batch.
 */
export const AGENT_SESSION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];
