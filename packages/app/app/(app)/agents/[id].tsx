import { AgentDetail } from '@/features/agents/ui/detail/agent-detail';
import { useAgentReviews } from '@/features/agents/runtime/use-agent-reviews';
import { useAgentThreads } from '@/features/agents/runtime/use-agent-threads';
import { useAgent } from '@/features/agents/runtime/use-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { Loading } from '@oxy.so/bloom/loading';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

/**
 * An agent's page. The route reads the id and loads the agent; the page itself
 * is `src/features/agents/ui/detail/agent-detail.tsx`, and what its buttons do is
 * `src/features/agents/runtime/use-agent-detail-actions.ts` — which opens and starts work
 * in agent THREADS, never bare conversations.
 */
export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  /*
   * One cache, not two. This screen used to copy the fetched agent into local
   * state and then hand-patch that copy after a write — a third place holding
   * the same record, and the reason a change made here could go unseen
   * elsewhere. The query IS the state; a write updates it where it lives.
   */
  const { data: agent, isPending: loading } = useAgent(id);
  // Asked for alongside the agent rather than after it; the page reads the
  // same cached answers.
  useAgentThreads(id);
  useAgentReviews(id);

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Stack.Screen options={{ headerBackVisible: true }} />
        <Loading variant="spinner" text={t('common.loading')} />
      </View>
    );
  }

  if (!agent) {
    return (
      <>
        <Stack.Screen options={{ headerBackVisible: true }} />
        <EmptyState
          icon={RiRobot2Line}
          title={t('agents.notFound')}
          action={{
            label: t('agents.backToAgents'),
            onPress: () => router.back(),
          }}
        />
      </>
    );
  }

  return <AgentDetail agent={agent} />;
}
