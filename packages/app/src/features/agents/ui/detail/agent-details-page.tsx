import { AgentDetail } from '@/features/agents/ui/detail/agent-detail';
import { useAgentReviews } from '@/features/agents/runtime/use-agent-reviews';
import { useAgentThreads } from '@/features/agents/runtime/use-agent-threads';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { EmptyState } from '@/shared/stickers/empty-state';
import { DetailSkeleton } from '@/shared/ui/skeletons';
import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';

/**
 * An agent's page for a route that has looked the agent up: its skeleton while that is in flight,
 * the one 'not found' when there is no agent to show (no such agent, a draft, one out of reach: the
 * API answers all three alike), and the page. Shared by the page's two addresses, by handle
 * (`/@pepe/details`) and by id (`/agents/:id`, for an agent with no handle), so they cannot differ.
 */
export function AgentDetailsPage({
  agent,
  pending,
}: {
  agent: Agent | undefined;
  pending: boolean;
}) {
  const router = useRouter();
  const { t } = useTranslation();
  // Asked for alongside the agent rather than after it; the page reads the same cached answers.
  useAgentThreads(agent?._id);
  useAgentReviews(agent?._id);

  if (pending && agent === undefined) {
    return (
      <View className="flex-1">
        <Stack.Screen options={{ headerBackVisible: true }} />
        <DetailSkeleton />
      </View>
    );
  }

  if (agent === undefined) {
    return (
      <>
        <Stack.Screen options={{ headerBackVisible: true }} />
        <EmptyState
          sticker="agentNotFound"
          title={t('agents.notFound')}
          action={{ label: t('agents.backToAgents'), onPress: () => router.back() }}
        />
      </>
    );
  }

  return <AgentDetail agent={agent} />;
}
