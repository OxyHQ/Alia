/**
 * Where an agent is addressed, and the pure builders of those addresses.
 *
 * An agent is addressed by its Oxy handle and by nothing else: `/@pepe` is its thread,
 * `/@pepe/details` its page and `/@pepe/edit` its editor. Every address is a STRING with the `@`
 * written out, never a route object `{ pathname: '/(app)/[username]', params: { username: '@pepe' } }`:
 * Expo Router encodes a dynamic segment's value, so the object form put `/%40pepe` in the address
 * bar. An agent Oxy resolved no handle for has no address: its builders answer `null`, and a screen
 * that would link to it offers no link.
 *
 * They live in `shared/` because chat, the sidebar and the agents' own screens all link to agents
 * and none of them may import another's feature.
 */

import type { Agent } from '@/shared/contracts/agents';

/** The identity fields any renderable agent-like row carries. */
type AgentIdentityFields = Pick<Agent, 'name' | 'handle'>;

/** The handle to SHOW, without the `@`. Empty when Oxy resolved nothing. */
export function agentHandle(agent: AgentIdentityFields): string {
  return agent.handle?.trim() ?? '';
}

/**
 * The address of an agent's permanent thread: `/@pepe`, or `/@pepe?threadId=…` for one stretch.
 *
 * A STRING, never a route object, for the reason above. Every link to a thread goes through here,
 * so no screen spells it a second way.
 */
export function agentThreadHref(handle: string, threadId?: string): `/@${string}` {
  const path = `/@${handle}` as const;
  return threadId === undefined ? path : `${path}?threadId=${encodeURIComponent(threadId)}`;
}

/** Where "Chat" with this agent goes: its thread, or `null` when it has no handle to be addressed by. */
export function agentChatRoute(agent: AgentIdentityFields): `/@${string}` | null {
  const handle = agentHandle(agent);
  return handle === '' ? null : agentThreadHref(handle);
}

/** The address of an agent's page: `/@pepe/details`, or `null` with no handle. */
export function agentDetailsRoute(agent: AgentIdentityFields): `/@${string}/details` | null {
  const handle = agentHandle(agent);
  return handle === '' ? null : `/@${handle}/details`;
}

/** The address of an agent's editor screen (a phone's): `/@pepe/edit`, or `null` with no handle. */
export function agentEditRoute(agent: AgentIdentityFields): `/@${string}/edit` | null {
  const handle = agentHandle(agent);
  return handle === '' ? null : `/@${handle}/edit`;
}
