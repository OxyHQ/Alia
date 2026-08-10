/**
 * Closed value sets for `context-edge`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
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
