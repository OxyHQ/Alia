/**
 * Closed value sets for `context-edge`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
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
