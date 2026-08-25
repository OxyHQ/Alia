/**
 * Rendering an agent whose identity lives in Oxy.
 *
 * `Agent.name`, `.handle` and `.color` are nullable because the API resolves
 * them through a batched Oxy lookup that FAILS OPEN: an account it cannot
 * resolve — deleted, federated, or unreachable because Oxy is having a bad
 * afternoon — arrives as three nulls, and the listing still renders because the
 * tagline, the rating and the price are Alia's own.
 *
 * `color` has no helper here because it needs none that is about IDENTITY: what
 * to do with an unusable value is a RENDERING decision, made once in
 * `lib/agents/agent-color.ts` and handed to the mark as a colour.
 *
 * Every surface therefore needs the same fallback, and it is here rather than
 * inlined at each one: two screens disagreeing about what an unresolved agent
 * is called is a difference nobody reports.
 */

import type { Agent } from '@/lib/types/agents';

/** The identity fields any renderable agent-like row carries. */
type AgentIdentityFields = Pick<Agent, 'name' | 'handle'>;

/**
 * The name to SHOW. Never empty.
 *
 * The handle is tried before the generic word because it is still the agent's
 * own identity — an account Oxy resolved only partially is better rendered as
 * `@researcher` than as "Agent".
 */
export function agentDisplayName(agent: AgentIdentityFields): string {
  return agent.name?.trim() || agent.handle?.trim() || 'Agent';
}

/** The handle to SHOW, without the `@`. Empty when Oxy resolved nothing. */
export function agentHandle(agent: AgentIdentityFields): string {
  return agent.handle?.trim() ?? '';
}

/** Whether a query matches what a person can actually see of this agent. */
export function agentIdentityMatches(agent: AgentIdentityFields, query: string): boolean {
  const lowered = query.toLowerCase();
  return (
    agentDisplayName(agent).toLowerCase().includes(lowered) ||
    agentHandle(agent).toLowerCase().includes(lowered)
  );
}
