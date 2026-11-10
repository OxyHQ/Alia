import { AgentDetailSection, ChipList } from '@/features/agents/ui/detail/agent-detail-section';
import { AgentHeaderActions } from '@/features/agents/ui/detail/agent-header-actions';
import { AgentIdentitySummary } from '@/features/agents/ui/detail/agent-identity-summary';
import { AgentReviewsSection } from '@/features/agents/ui/detail/agent-reviews-section';
import { AgentThreadsList } from '@/features/agents/ui/detail/agent-threads-list';
import { ActivityGrid } from '@/features/agents/ui/detail/activity-grid';
import { agentDisplayName } from '@/features/agents/model/identity';
import { agentHandle } from '@/shared/routing/agent-address';
import { CAPABILITY_FAMILIES } from '@/features/chat/model/capability-families';
import { useOpenAgentEditor } from '@/features/chat/runtime/use-open-agent-editor';
import { useAgentDetailActions } from '@/features/agents/runtime/use-agent-detail-actions';
import { useAgentThreads } from '@/features/agents/runtime/use-agent-threads';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { ResponsiveGrid } from '@oxy.so/bloom/grid';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services/ui/client';
import { Stack, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * The granted families, by their label KEYS, for the listing.
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

/** The narrowest a section is drawn before the grid drops a column. */
const SECTION_MIN_WIDTH = 320;
/** The widest the page's column grows: three sections of a readable width, never stretched wider. */
const PAGE_MAX_WIDTH = 1120;

/** One loaded agent's page: who it is, what it has done, what people said. */
export function AgentDetail({ agent }: { agent: Agent }) {
  const router = useRouter();
  const openAgentEditor = useOpenAgentEditor();
  const { t } = useTranslation();
  const { user } = useOxy();
  const { data: agentThreads = [] } = useAgentThreads(agent._id);
  const actions = useAgentDetailActions(agent);

  const isOwner = !!(user && user.id === agent.author);
  const handle = agentHandle(agent);
  const capabilityLabels = grantedFamilyLabels(agent.capabilityGrants ?? []).map((key) => t(key));

  /**
   * The page's sections, each one a cell of a grid whose columns follow the room it has: as many as
   * fit at a readable width (`SECTION_MIN_WIDTH`), up to three, one on a phone, in a column no wider
   * than `PAGE_MAX_WIDTH` so a section is never stretched across a big screen. `flow="columns"`
   * stacks them in independent columns, so a tall section (the reviews) leaves no gap under a short
   * one beside it.
   */
  const sections: ReactNode[] = [
    ...(isOwner
      ? [
          <SettingsListGroup key="owner">
            <SettingsListItem
              title={
                agent.status === 'active' ? t('agents.statusActive') : t('agents.statusPaused')
              }
              description={
                agent.status === 'active'
                  ? t('agents.acceptingHires')
                  : t('agents.notAcceptingHires')
              }
              rightElement={
                <Switch
                  accessibilityLabel={t('agents.acceptingHires')}
                  checked={agent.status === 'active'}
                  onCheckedChange={(on) => actions.handleStatusToggle(on ? 'active' : 'idle')}
                />
              }
            />
          </SettingsListGroup>,
        ]
      : []),
    // Only when there are threads: a cell that draws nothing would still take its gap in the column.
    ...(agentThreads.length > 0
      ? [
          <AgentThreadsList
            key="threads"
            threads={agentThreads}
            onOpen={(thread) => {
              if (handle) actions.openThread(handle, thread.id);
            }}
          />,
        ]
      : []),
    <AgentDetailSection key="activity" title={t('agents.activity')}>
      <ActivityGrid agentId={agent._id} />
    </AgentDetailSection>,
    <AgentDetailSection key="about" title={t('agents.about')}>
      <Text variant="body-regular">{agent.description}</Text>
    </AgentDetailSection>,
    // Capabilities — the families this agent was granted, by their own labels. A connector grant
    // (`mcp:<id>`) is deliberately not shown: the id is meaningless to a reader and the connector
    // belongs to the owner, not to this public listing.
    ...(capabilityLabels.length > 0
      ? [
          <AgentDetailSection key="capabilities" title={t('agents.capabilities')}>
            <ChipList items={capabilityLabels} />
          </AgentDetailSection>,
        ]
      : []),
    ...(agent.tags.length > 0
      ? [
          <AgentDetailSection key="tags" title={t('agents.tags')}>
            <ChipList items={agent.tags} />
          </AgentDetailSection>,
        ]
      : []),
    <AgentReviewsSection
      key="reviews"
      agentId={agent._id}
      viewerId={user?.id ?? null}
      isOwner={isOwner}
    />,
  ];

  return (
    <View className="flex-1">
      <Stack.Screen
        options={{
          title: agentDisplayName(agent),
          headerBackVisible: true,
          headerRight: () => (
            <AgentHeaderActions
              isOwner={isOwner}
              canChat={agent.access === 'public' || isOwner}
              onEdit={() => openAgentEditor(agent._id)}
              onChat={actions.handleChat}
              onShare={actions.handleShare}
              hasComputer={
                (agent.access === 'public' || isOwner) &&
                (agent.capabilityGrants ?? []).includes('computer')
              }
              onComputer={() =>
                router.push({
                  pathname: '/(app)/agents/computer/[id]',
                  params: { id: agent._id },
                })
              }
            />
          ),
        }}
      />
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="w-full items-center p-4">
          <View className="w-full gap-6" style={{ maxWidth: PAGE_MAX_WIDTH }}>
            <AgentIdentitySummary agent={agent} />
            <ResponsiveGrid
              flow="columns"
              minItemWidth={SECTION_MIN_WIDTH}
              maxColumns={3}
              gap={24}
              testID="agent-details-grid"
            >
              {sections}
            </ResponsiveGrid>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
