/**
 * Where an agent is addressed, and the pure builders of those addresses.
 *
 * An agent is addressed by its Oxy handle: `/@pepe` is its thread, `/@pepe/details` its page and
 * `/@pepe/edit` its editor. Every address is a STRING with the `@` written out, never a route
 * object `{ pathname: '/(app)/[username]', params: { username: '@pepe' } }`: Expo Router encodes a
 * dynamic segment's value, so the object form put `/%40pepe` in the address bar. An agent Oxy
 * resolved no handle for has no address; it falls back to its page by id (`/agents/:id`,
 * `/agents/edit/:id`), which also receives the links shared before the pages moved and sends a
 * handled agent on to its address.
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
 * Where "Chat" with this agent goes: its permanent thread, `/@handle`, or —
 * when Oxy resolved no handle, so the thread has no address — its profile,
 * which says why it cannot be opened yet.
 *
 * The catalogue card's "Chat" used to push the profile unconditionally, the
 * same place pressing the card itself goes, so a button labelled "Chat" was a
 * second way to open a page (#608, rule 6).
 */
export function agentChatRoute(
  agent: AgentIdentityFields & Pick<Agent, '_id'>,
): `/@${string}` | AgentByIdRoute<'/(app)/agents/[id]'> {
  const handle = agentHandle(agent);
  return handle === ''
    ? { pathname: '/(app)/agents/[id]', params: { id: agent._id } }
    : agentThreadHref(handle);
}

/**
 * The address of an agent's permanent thread: `/@pepe`, or `/@pepe?threadId=…` for one stretch.
 *
 * A STRING, never `{ pathname: '/(app)/[username]', params: { username: '@pepe' } }`: Expo Router
 * encodes a dynamic segment's value, so the object form put `/%40pepe` in the address bar. The
 * `@` is part of the route's value (`app/(app)/[username]/index.tsx`), and a path written out keeps it.
 * Every link to a thread goes through here, so no screen spells it a second way.
 */
export function agentThreadHref(handle: string, threadId?: string): `/@${string}` {
  const path = `/@${handle}` as const;
  return threadId === undefined ? path : `${path}?threadId=${encodeURIComponent(threadId)}`;
}

/** A route that needs the agent's id because the agent has no handle to be addressed by. */
type AgentByIdRoute<Path extends string> = { pathname: Path; params: { id: string } };

/**
 * The address of an agent's page: `/@pepe/details`, a string for the reason `agentThreadHref` is
 * one. An agent Oxy resolved no handle for has no such address, so it falls back to its page by id
 * (`/agents/:id`), which is also where an old shared link lands and is sent on to `/@handle/details`.
 */
export function agentDetailsRoute(
  agent: AgentIdentityFields & Pick<Agent, '_id'>,
): `/@${string}/details` | AgentByIdRoute<'/(app)/agents/[id]'> {
  const handle = agentHandle(agent);
  return handle === ''
    ? { pathname: '/(app)/agents/[id]', params: { id: agent._id } }
    : `/@${handle}/details`;
}

/** The address of an agent's editor screen (a phone's): `/@pepe/edit`, or by id with no handle. */
export function agentEditRoute(
  agent: AgentIdentityFields & Pick<Agent, '_id'>,
): `/@${string}/edit` | AgentByIdRoute<'/(app)/agents/edit/[id]'> {
  const handle = agentHandle(agent);
  return handle === ''
    ? { pathname: '/(app)/agents/edit/[id]', params: { id: agent._id } }
    : `/@${handle}/edit`;
}

/** What an agent's page is called in a link that leaves the app (a share): its handle's address, else its id's. */
export function agentSharePath(agent: AgentIdentityFields & Pick<Agent, '_id'>): string {
  const handle = agentHandle(agent);
  return handle === '' ? `/agents/${agent._id}` : `/@${handle}/details`;
}
