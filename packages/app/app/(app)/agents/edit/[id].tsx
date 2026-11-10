import { agentEditRoute, agentHandle } from '@/shared/routing/agent-address';
import { useAgent } from '@/features/agents/runtime/use-agents';
import { AgentEditorLoader } from '@/features/agents/ui/edit/agent-editor-loader';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';

/**
 * `/agents/edit/:id` — the old address of the editor screen, and still the one of an agent with no
 * handle. An agent with a handle is sent on to `/@handle/edit`, its address now; one Oxy resolved
 * no handle for has no such address, so the editor is drawn here, by id, with its own header only.
 */
export default function EditAgentByIdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: agent } = useAgent(id);
  const toList = () => router.replace('/(app)/agents');
  if (agent && agentHandle(agent) !== '') {
    return <Redirect href={agentEditRoute(agent) as `/@${string}/edit`} />;
  }
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AgentEditorLoader
        agentId={id}
        onClose={() => (router.canGoBack() ? router.back() : toList())}
        onBackToList={toList}
      />
    </>
  );
}
