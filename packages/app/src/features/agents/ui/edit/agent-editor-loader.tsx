import { useAgent } from '@/features/agents/runtime/use-agents';
import { AgentEditor } from '@/features/agents/ui/edit/agent-editor';
import {
  AgentEditorLoadFailed,
  AgentEditorLoading,
} from '@/features/agents/ui/edit/agent-editor-load-states';

/**
 * Load the agent, then hand it to the editor. Shared by the panel and by the phone's screen
 * (`app/(app)/agents/edit/[id].tsx`), so neither carries the other's chrome.
 */
export function AgentEditorLoader({
  agentId,
  onBackToList,
}: {
  agentId: string | undefined;
  onBackToList: () => void;
}) {
  const { data: agent, isError, error, refetch } = useAgent(agentId);
  if (agent !== undefined) return <AgentEditor key={agent._id} agent={agent} />;
  /**
   * A query that FAILED is not one that is loading: an errored query leaves `data` undefined
   * forever, so a 404 would read as a fetch in flight and never leave "Loading…" (#530).
   */
  if (isError) {
    return (
      <AgentEditorLoadFailed
        error={error}
        onRetry={() => void refetch()}
        onBackToList={onBackToList}
      />
    );
  }
  return <AgentEditorLoading />;
}
