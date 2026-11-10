import { AgentHearsSection } from '@/features/agents/ui/edit/sections/agent-hears-section';
import { AgentInboxSection } from '@/features/agents/ui/edit/sections/agent-inbox-section';
import { AgentMemorySection } from '@/features/agents/ui/edit/sections/agent-memory-section';
import { AgentWorkSection } from '@/features/agents/ui/edit/sections/agent-work-section';

/**
 * What an agent HAS beyond who it is, as the cards below the editor's details card: how it works
 * on its own, what it hears about, what waits in its inbox and what it remembers about the person.
 * They are per agent, so they live here, where the agent is edited, and not in the settings.
 */
export function AgentEditorSections({ agentId, name }: { agentId: string; name: string }) {
  return (
    <>
      <AgentWorkSection agentId={agentId} name={name} />
      <AgentHearsSection agentId={agentId} name={name} />
      <AgentInboxSection agentId={agentId} name={name} />
      <AgentMemorySection agentId={agentId} name={name} />
    </>
  );
}
