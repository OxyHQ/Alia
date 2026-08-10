/**
 * Closed value sets for `agent`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

export const AGENT_ARCHETYPES = ['general', 'qa', 'task_router', 'status_update'] as const;
export type AgentArchetype = (typeof AGENT_ARCHETYPES)[number];
/**
 * Exported as a TUPLE for the same reason `AGENT_ARCHETYPES` already is: the
 * Postgres schema renders its CHECK from this exact value rather than retyping
 * it, so the constraint and this validator cannot drift apart.
 */
export const AGENT_STATUSES = ['active', 'idle', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
