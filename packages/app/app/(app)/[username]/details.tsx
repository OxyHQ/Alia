import { useAgent, useAgentByHandle } from '@/features/agents/runtime/use-agents';
import { AgentDetailsPage } from '@/features/agents/ui/detail/agent-details-page';
import { useLocalSearchParams } from 'expo-router';

/**
 * `/@pepe/details` — an agent's page, by its handle: the address of an agent is its handle.
 *
 * The `@` is in the segment's value, as for `/@pepe` (`./index.tsx`), and is stripped once, here. A
 * handle that is no agent, a draft and an agent out of reach are ONE state, the API's 404, drawn
 * by `AgentDetailsPage`. The page itself is `features/agents/ui/detail/agent-detail.tsx`, and what
 * its buttons do is `features/agents/runtime/use-agent-detail-actions.ts` — which opens and starts
 * work in agent THREADS, never bare conversations.
 */
export default function AgentDetailsScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const handle = username?.replace(/^@+/, '') ?? '';
  const { data: resolved, isPending } = useAgentByHandle(handle);
  // The one cache of the agent: what the page reads and every write updates. The card the handle
  // lookup found was put there, so this asks for nothing again.
  const { data: live } = useAgent(resolved?._id);
  return <AgentDetailsPage agent={live ?? resolved} pending={isPending && handle !== ''} />;
}
