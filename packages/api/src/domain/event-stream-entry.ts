/**
 * Closed value sets for `event-stream-entry`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

/**
 * The event vocabulary, defined ONCE and imported by `agent-session.ts`.
 *
 * It was two identical fourteen-value literals in two files — this collection
 * and `AgentSession.eventStream`, which is the legacy embedded copy of the same
 * events. That is the `ALIA_TIERS` shape exactly: one vocabulary, two copies,
 * and therefore no single tuple for the Postgres CHECK to render from. Adding a
 * fifteenth type to one file and not the other would have gone unnoticed until
 * a write failed against whichever CHECK was rendered from the stale copy.
 *
 * This file owns it because this collection is the live store; the embedded
 * array is the fallback `lib/agent/runner.ts` still writes.
 */
export const EVENT_STREAM_ENTRY_TYPES = [
  'user_message',
  'system_message',
  'action',
  'observation',
  'error',
  'plan_update',
  'thinking',
  'response',
  'complete',
  'screenshot',
  'plan_progress',
  'file_change',
  'source_found',
  'threat_detected',
] as const;
export type EventStreamEntryType = (typeof EVENT_STREAM_ENTRY_TYPES)[number];
