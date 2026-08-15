/**
 * Closed value sets for `context-node`.
 *
 * These live OUTSIDE the schema module because the drizzle schema renders its
 * CHECK constraints from these exact tuples, and the repositories and validators
 * guarding the same columns import the same tuples — so a constraint and the
 * code enforcing it cannot drift apart. The Mongoose model these once
 * accompanied has been deleted.
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
