import { agentDetailsRoute, agentHandle } from '@/shared/routing/agent-address';
import { useAgent } from '@/features/agents/runtime/use-agents';
import { AgentDetailsPage } from '@/features/agents/ui/detail/agent-details-page';
import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * `/agents/:id` — the old address of an agent's page, and still the one of an agent with no handle.
 *
 * Links shared before the page moved (`agentShareMessage` printed this URL) land here: an agent
 * with a handle is sent on to `/@handle/details`, its address now. An agent Oxy resolved no handle
 * for has no such address, so its page is drawn here, by id.
 */
export default function AgentByIdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: agent, isPending } = useAgent(id);
  if (agent && agentHandle(agent) !== '') {
    return <Redirect href={agentDetailsRoute(agent) as `/@${string}/details`} />;
  }
  return <AgentDetailsPage agent={agent} pending={isPending} />;
}
