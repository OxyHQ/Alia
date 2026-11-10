import { useAgentByHandle } from '@/features/agents/runtime/use-agents';
import { AgentEditorLoader } from '@/features/agents/ui/edit/agent-editor-loader';
import {
  AgentEditorLoadFailed,
  AgentEditorLoading,
} from '@/features/agents/ui/edit/agent-editor-load-states';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

/**
 * `/@pepe/edit` — the agent editor as a screen, for a phone. From the `md` breakpoint up the editor
 * is the right panel beside the conversation (`useOpenAgentEditor`); this route is the same editor
 * where a panel would be a drawer over the chat.
 *
 * Found by handle, like `/@pepe/details`; the API answers the card to whoever may see it, and the
 * editor is for whoever may edit it (its fields are only written through the agent's own account).
 * The screen's only header is the editor's own (`OWN_HEADER_ROUTES` in the layout), so there is no
 * second bar above it.
 */
export default function EditAgentScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const handle = username?.replace(/^@+/, '') ?? '';
  const router = useRouter();
  const { data: agent, isError, error, refetch } = useAgentByHandle(handle);
  const toList = () => router.replace('/(app)/agents');

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {agent !== undefined ? (
        <AgentEditorLoader
          agentId={agent._id}
          onClose={() => (router.canGoBack() ? router.back() : toList())}
          onBackToList={toList}
        />
      ) : isError ? (
        <AgentEditorLoadFailed error={error} onRetry={() => void refetch()} onBackToList={toList} />
      ) : (
        <AgentEditorLoading />
      )}
    </>
  );
}
