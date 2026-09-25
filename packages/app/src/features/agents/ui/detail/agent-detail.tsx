import { AgentTerminal } from '@/features/chat/ui/workspace/agent-terminal';
import {
  AgentDetailSection,
  ChipList,
} from '@/features/agents/ui/detail/agent-detail-section';
import { AgentHeaderActions } from '@/features/agents/ui/detail/agent-header-actions';
import { AgentIdentitySummary } from '@/features/agents/ui/detail/agent-identity-summary';
import { AgentReviewsSection } from '@/features/agents/ui/detail/agent-reviews-section';
import { AgentThreadsList } from '@/features/agents/ui/detail/agent-threads-list';
import { Composer } from '@/features/chat/ui/composer/composer';
import { ActivityGrid } from '@/features/agents/ui/detail/activity-grid';
import { agentDisplayName, agentHandle } from '@/features/agents/model/identity';
import { CAPABILITY_FAMILIES } from '@/features/chat/model/capability-families';
import { useAgentDetailActions } from '@/features/agents/runtime/use-agent-detail-actions';
import { useAgentThreads } from '@/features/agents/runtime/use-agent-threads';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { Divider } from '@oxy.so/bloom/divider';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import { Stack, useRouter } from 'expo-router';
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

/** One loaded agent's page: who it is, what it has done, what people said. */
export function AgentDetail({ agent }: { agent: Agent }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const isLargeScreen = useIsLargeScreen();
  const { data: agentThreads = [] } = useAgentThreads(agent._id);
  const actions = useAgentDetailActions(agent);

  const isOwner = !!(user && user.id === agent.author);
  const handle = agentHandle(agent);
  const capabilityLabels = grantedFamilyLabels(agent.capabilityGrants ?? []).map(
    (key) => t(key),
  );

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
              onEdit={() =>
                router.push({
                  pathname: '/(app)/agents/edit/[id]',
                  params: { id: agent._id },
                })
              }
              onChat={actions.handleChat}
              onStartTask={actions.handleHirePress}
              onShare={actions.handleShare}
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
                title={
                  agent.status === 'active'
                    ? t('agents.statusActive')
                    : t('agents.statusPaused')
                }
                description={
                  agent.status === 'active'
                    ? t('agents.acceptingHires')
                    : t('agents.notAcceptingHires')
                }
                rightElement={
                  <Switch
                    accessibilityLabel={t('agents.acceptingHires')}
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
          {/* No status dot beside the title: it was a green dot drawn
              unconditionally, a "live" signal that knew nothing about the
              terminal's connection (#608, rule 6). */}
          <Text variant="headline-semibold">{t('agents.activity')}</Text>
          <View className="flex-1">
            <AgentTerminal agentId={agent._id} />
          </View>
        </View>
      )}
    </View>
  );
}
