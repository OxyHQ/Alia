/**
 * What an agent-run event records.
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
