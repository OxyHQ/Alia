import { useMyAgents } from '@/lib/hooks/use-my-agents';
import type { Agent } from '@/lib/types/agents';
import { useCallback, useMemo } from 'react';

/** An agent, as a list names it: its name, else its handle, else its id. */
export function agentLabel(agent: Pick<Agent, '_id' | 'name' | 'handle'>): string {
  return agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`;
}

/**
 * The person's own agents, and a lookup from id to label.
 *
 * The work list and an automation's history both name agents by id — the
 * automation that picked one, the run it went to — and both used to build the
 * same map by hand. An id with no agent behind it (deleted, or somebody
 * else's) still gets a label rather than a blank.
 */
export function useAgentNames() {
  const agents = useMyAgents();
  const names = useMemo(
    () =>
      new Map((agents.data ?? []).map((agent) => [agent._id, agentLabel(agent)])),
    [agents.data],
  );
  const agentName = useCallback(
    (agentId: string) => names.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`,
    [names],
  );
  return { agents: agents.data, agentName };
}
