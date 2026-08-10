/**
 * Closed value sets for `context-source`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

export const CONTEXT_SOURCE_KINDS = [
  'calendar',
  'email',
  'notes',
  'files',
  'integration',
  'oxy_service',
  'agent_session',
  'web',
  'memory',
  'unknown',
] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];
export const CONTEXT_SOURCE_AVAILABILITIES = ['available', 'degraded', 'disabled'] as const;
export type ContextSourceAvailability = (typeof CONTEXT_SOURCE_AVAILABILITIES)[number];
