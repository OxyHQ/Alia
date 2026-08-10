/**
 * Closed value sets for `context-node`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
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
