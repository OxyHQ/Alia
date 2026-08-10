/**
 * How one context-graph node relates to another.
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

export const CONTEXT_EDGE_TYPES = [
  'mentions',
  'belongs_to',
  'related_to',
  'created_by',
  'updated_by',
  'references',
  'discovered_in',
  'depends_on',
  'tagged_as',
  'unknown',
] as const;

export type ContextEdgeType = (typeof CONTEXT_EDGE_TYPES)[number];
