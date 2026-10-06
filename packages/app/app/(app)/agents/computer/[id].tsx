import { AgentComputer } from '@/features/agents/ui/computer/agent-computer';
import { agentDisplayName } from '@/features/agents/model/identity';
import { useAgent } from '@/features/agents/runtime/use-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Stack, useLocalSearchParams } from 'expo-router';

/**
 * An agent's computer — its live browser, its files, what it ran — as the
 * signed-in person's own computer with that agent. The page is
 * `src/features/agents/ui/computer/agent-computer.tsx`; reached from the
 * agent's page (`agent-header-actions.tsx`).
 */
export default function AgentComputerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { data: agent } = useAgent(id);

  return (
    <>
      <Stack.Screen
        options={{
          title: agent ? t('agents.computer.title', { name: agentDisplayName(agent) }) : t('agents.computer.open'),
          headerBackVisible: true,
        }}
      />
      <AgentComputer agentId={id} />
    </>
  );
}
