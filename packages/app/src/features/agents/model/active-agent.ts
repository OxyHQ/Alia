import type { Agent } from '@/shared/contracts/agents';
import { agentHandle } from './identity';

/**
 * The agent whose thread or conversation the path shows, if any: `/@handle` is the agent's
 * permanent thread, and `/c/:id` is a chat that belongs to an agent. Anything else shows no agent,
 * so the app keeps its own theme there.
 */
export function activeAgentFor({
  pathname,
  agents,
  conversations,
}: {
  pathname: string;
  agents: readonly Agent[];
  conversations: readonly { id: string; agentId?: string | null }[];
}): Agent | undefined {
  const handle = /^\/@([^/]+)$/.exec(pathname)?.[1];
  if (handle !== undefined) {
    const wanted = decodeURIComponent(handle);
    return agents.find((agent) => agentHandle(agent) === wanted);
  }
  const conversationId = /^\/c\/([^/]+)/.exec(pathname)?.[1];
  if (conversationId !== undefined) {
    const agentId = conversations.find(
      (conversation) => conversation.id === conversationId,
    )?.agentId;
    return agentId ? agents.find((agent) => agent._id === agentId) : undefined;
  }
  return undefined;
}
