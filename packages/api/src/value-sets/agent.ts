/**
 * The marketplace agent's archetype and liveness.
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

export const AGENT_ARCHETYPES = ['general', 'qa', 'task_router', 'status_update'] as const;

export type AgentArchetype = (typeof AGENT_ARCHETYPES)[number];

/**
 * Exported as a TUPLE for the same reason `AGENT_ARCHETYPES` already is: the
 * Postgres schema renders its CHECK from this exact value rather than retyping
 * it, so the constraint and this validator cannot drift apart.
 */
export const AGENT_STATUSES = ['active', 'idle', 'offline'] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
