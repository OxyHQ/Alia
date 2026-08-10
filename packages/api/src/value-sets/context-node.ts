/**
 * What a context-graph node is.
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

export const CONTEXT_NODE_TYPES = [
  'person',
  'project',
  'document',
  'thread',
  'calendar_event',
  'integration',
  'memory',
  'conversation',
  'agent',
  'service',
  'tag',
  'unknown',
] as const;

export type ContextNodeType = (typeof CONTEXT_NODE_TYPES)[number];
