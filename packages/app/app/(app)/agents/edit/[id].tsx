import { AgentEditorLoader } from '@/features/agents/ui/edit/agent-editor-loader';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

/**
 * The agent editor as a screen, for a phone. From the `md` breakpoint up the editor is the right
 * panel beside the conversation (`useOpenAgentEditor`); this route is the same editor where a
 * panel would be a drawer over the chat.
 */
export default function EditAgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <>
      <Stack.Screen options={{ title: t('panel.editor'), headerBackVisible: true }} />
      <AgentEditorLoader agentId={id} onBackToList={() => router.replace('/(app)/agents')} />
    </>
  );
}
