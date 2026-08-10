/**
 * An agent run's lifecycle, and the resources it claims.
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

export const AGENT_SESSION_RESOURCE_TYPES = ['vm', 'container'] as const;

export type AgentSessionResourceType = (typeof AGENT_SESSION_RESOURCE_TYPES)[number];

export const AGENT_SESSION_RESOURCE_STATUSES = ['active', 'destroyed'] as const;

export type AgentSessionResourceStatus = (typeof AGENT_SESSION_RESOURCE_STATUSES)[number];
