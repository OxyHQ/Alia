import { AgentTerminal } from '@/components/agent-terminal';
import {
  AgentDetailSection,
  ChipList,
} from '@/components/agents/detail/agent-detail-section';
import { AgentHeaderActions } from '@/components/agents/detail/agent-header-actions';
import { AgentIdentitySummary } from '@/components/agents/detail/agent-identity-summary';
import { AgentReviewsSection } from '@/components/agents/detail/agent-reviews-section';
import { AgentThreadsList } from '@/components/agents/detail/agent-threads-list';
import { Composer } from '@/components/chat/composer/composer';
import { ActivityGrid } from '@/components/detail/activity-grid';
import { agentDisplayName, agentHandle } from '@/lib/agents/identity';
import { CAPABILITY_FAMILIES } from '@/lib/constants/capability-families';
import { useAgentDetailActions } from '@/lib/hooks/agents/use-agent-detail-actions';
import { useAgentThreads } from '@/lib/hooks/use-agent-threads';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useAgentFavoritesStore } from '@/lib/stores/agent-favorites-store';
import type { Agent } from '@/lib/types/agents';
import { Badge } from '@oxy.so/bloom/badge';
import { Divider } from '@oxy.so/bloom/divider';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * The granted families, by label, for the listing.
 *
 * Derived rather than stored: the row carries grant STRINGS, and a family the
 * app does not know about is skipped rather than rendered raw.
 */
export function grantedFamilyLabels(grants: readonly string[]): string[] {
  return grants.flatMap((grant) => {
    const family = CAPABILITY_FAMILIES.find((entry) => entry.id === grant);
    return family === undefined ? [] : [family.label];
  });
}

/** One loaded agent's page: who it is, what it has done, what people said. */
export function AgentDetail({ agent }: { agent: Agent }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const isLargeScreen = useIsLargeScreen();
  const { data: agentThreads = [] } = useAgentThreads(agent._id);
  const actions = useAgentDetailActions(agent);

  const toggleFavorite = useAgentFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useAgentFavoritesStore((s) => s.isFavorite);
  const loadFavorites = useAgentFavoritesStore((s) => s.loadFavorites);
  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  const isOwner = !!(user && user.id === agent.author);
  const handle = agentHandle(agent);
  const capabilityLabels = grantedFamilyLabels(agent.capabilityGrants ?? []);

  return (
    <View className={isLargeScreen ? 'flex-1 flex-row' : 'flex-1 flex-col'}>
      <Stack.Screen
        options={{
          title: agentDisplayName(agent),
          headerBackVisible: true,
          headerRight: () => (
            <AgentHeaderActions
              isOwner={isOwner}
              price={agent.price}
              bookmarked={isFavorite(agent._id)}
              onEdit={() =>
                router.push({
                  pathname: '/(app)/agents/edit/[id]',
                  params: { id: agent._id },
                })
              }
              onChat={actions.handleChat}
              onStartTask={actions.handleHirePress}
              onShare={actions.handleShare}
              onToggleBookmark={() => toggleFavorite(agent._id)}
            />
          ),
        }}
      />
      {/* Agent details (full width on mobile) */}
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View
          className={
            isLargeScreen
              ? 'w-full max-w-[672px] gap-5 p-4'
              : 'w-full gap-5 p-4'
          }
        >
          <AgentIdentitySummary agent={agent} />

          {/* Owner controls */}
          {isOwner && (
            <SettingsListGroup>
              <SettingsListItem
                title={agent.status === 'active' ? 'Active' : 'Paused'}
                description={
                  agent.status === 'active'
                    ? 'Accepting hires'
                    : 'Not accepting hires'
                }
                rightElement={
                  <Switch
                    accessibilityLabel="Accepting hires"
                    value={agent.status === 'active'}
                    onValueChange={(on) =>
                      actions.handleStatusToggle(on ? 'active' : 'idle')
                    }
                  />
                }
              />
            </SettingsListGroup>
          )}

          {/* The task for this agent, written in the app's composer. */}
          {actions.showHireInput && (
            <Composer
              value={actions.taskInput}
              onValueChange={actions.setTaskInput}
              onSubmit={actions.handleHireSubmit}
              busy={actions.hiring}
              disabled={actions.hiring}
              placeholder={t('agents.taskPlaceholder')}
            />
          )}

          {/* Overview */}
          <AgentThreadsList
            threads={agentThreads}
            onOpen={(thread) => {
              if (handle) actions.openThread(handle, thread.id);
            }}
          />

          <AgentDetailSection title={t('agents.activity')}>
            <ActivityGrid agentId={agent._id} />
          </AgentDetailSection>

          <Divider />

          <AgentDetailSection title={t('agents.about')}>
            <Text variant="body-regular">{agent.description}</Text>
          </AgentDetailSection>

          {/* Capabilities — the families this agent was granted, by their
              own labels. A connector grant (`mcp:<id>`) is deliberately not
              shown: the id is meaningless to a reader and the connector
              belongs to the owner, not to this public listing. */}
          {capabilityLabels.length > 0 && (
            <>
              <Divider />
              <AgentDetailSection title={t('agents.capabilities')}>
                <ChipList items={capabilityLabels} />
              </AgentDetailSection>
            </>
          )}

          {agent.tags.length > 0 && (
            <>
              <Divider />
              <AgentDetailSection title={t('agents.tags')}>
                <ChipList items={agent.tags} />
              </AgentDetailSection>
            </>
          )}

          <Divider />
          <AgentReviewsSection
            agentId={agent._id}
            viewerId={user?.id ?? null}
            isOwner={isOwner}
          />

          {/* Activity terminal — mobile only; desktop has it beside. */}
          {!isLargeScreen && (
            <>
              <Divider />
              <AgentDetailSection title={t('agents.activity')}>
                <View className="h-[300px]">
                  <AgentTerminal agentId={agent._id} />
                </View>
              </AgentDetailSection>
            </>
          )}
        </View>
      </ScrollView>

      {/* Activity terminal beside the details — desktop only */}
      {isLargeScreen && (
        <View className="flex-1 gap-2 p-4">
          <View className="flex-row items-center gap-2">
            <Badge dot color="success" />
            <Text variant="headline-semibold">{t('agents.activity')}</Text>
          </View>
          <View className="flex-1">
            <AgentTerminal agentId={agent._id} />
          </View>
        </View>
      )}
    </View>
  );
}
