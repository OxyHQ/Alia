/**
 * Where an agent opens, as Oxy says (Alia ADR 0021, Oxy ADR 0044).
 *
 * An Oxy application may confine its own agent to its own app — Clarity's
 * assistant opens only inside Clarity. That is Oxy's platform fact: Alia stores
 * no copy of it and offers no editor control for it, and reads it live from
 * `GET /capabilities/agent-availability/:agentAccountId` on its service lane.
 *
 * The answer is cached briefly per agent: a confinement Oxy adds or lifts takes
 * effect within a minute, and a turn, a search and a consultation in the same
 * minute ask once.
 *
 * ## An answer Oxy could not give is never "anywhere"
 *
 * `agency.agentAvailability` throws on anything but a valid 200, and this
 * module turns that into `identity_unavailable` — the answer `canReachAgent`
 * already gives when Oxy could not be asked. It is NOT `reachable`: reading an
 * outage as "anywhere" would open a confined agent everywhere for as long as
 * Oxy is down, which is the one thing confinement exists to prevent. It is not
 * `out_of_reach` either, because nothing was refused: the chat surface answers
 * it as a retryable failure instead of telling the person the agent does not
 * exist. Every caller that only needs a yes treats both as no. Failures are not
 * cached, so the next request asks again.
 */

import type { AgentAvailability } from '@oxy.so/contracts';
import { log } from './logger.js';
import { oxyServiceClient } from './oxy-service-client.js';
import { TTLCache } from './ttl-cache.js';

const AVAILABILITY_TTL_MS = 60_000;

const availabilities = new TTLCache<AgentAvailability>({
  ttlMs: AVAILABILITY_TTL_MS,
  maxSize: 10_000,
});

/** Oxy's answer for one agent account, or `null` when Oxy could not give one. */
async function readAvailability(agentAccountId: string): Promise<AgentAvailability | null> {
  try {
    return await availabilities.getOrLoad(agentAccountId, async () => {
      const client = oxyServiceClient();
      if (!client) throw new Error('Alia holds no Oxy service credential');
      return client.agency.agentAvailability(agentAccountId);
    });
  } catch (error: unknown) {
    log.agents.warn({ err: error, agentAccountId }, 'Could not read where an agent opens');
    return null;
  }
}

/**
 * Whether an agent opens on this surface.
 *
 * @param agentAccountId the agent's Oxy `bot` account (`agents.oxy_account_id`)
 * @param surfaceApplicationId the application of the request's verified app
 *   assertion (`lib/app-surface.ts`), or `null` when it has none
 */
export async function agentOpensOn(
  agentAccountId: string,
  surfaceApplicationId: string | null,
): Promise<'reachable' | 'out_of_reach' | 'identity_unavailable'> {
  const availability = await readAvailability(agentAccountId);
  if (availability === null) return 'identity_unavailable';
  if (availability.anywhere) return 'reachable';
  return surfaceApplicationId !== null && availability.applicationIds.includes(surfaceApplicationId)
    ? 'reachable'
    : 'out_of_reach';
}

/** Test seam: forget every cached answer. */
export function clearAgentAvailabilityCache(): void {
  availabilities.clear();
}
