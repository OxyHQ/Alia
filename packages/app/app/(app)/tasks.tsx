import { WorkItemRow } from '@/features/automations/ui/work-item-row';
import { WorkListHeader } from '@/features/automations/ui/work-list-header';
import type { AutomationDefinition } from '@/shared/contracts/automations';
import type { WorkItem } from '@/features/automations/model/work-items';
import { useAgentNames } from '@/features/agents/runtime/use-agent-names';
import { useAutomationControls } from '@/features/automations/runtime/use-automation-controls';
import { useWorkList } from '@/features/automations/runtime/use-work-list';
import type { TaskSession } from '@/features/automations/runtime/use-tasks';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiInbox2Line } from '@oxy.so/bloom/icons/RiInbox2Line';
import { Loading } from '@oxy.so/bloom/loading';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

/**
 * The one place work is seen and managed (#537).
 *
 * Sessions agents run and the automations that start them are merged into a
 * single list by `unifiedWorkItems` (through `useWorkList`), which documents
 * the tab semantics and the order. Automations reach this page through the
 * same overview query the create dialog invalidates, so a new one appears here
 * without a reload; its controls (pause/resume, run now, history) are the ones
 * the Automations page used to host.
 */

function TaskSeparator() {
  return <Divider />;
}

export default function TasksPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const work = useWorkList();
  const { agentName } = useAgentNames();
  const controls = useAutomationControls();

  const handleTaskPress = useCallback(
    (task: TaskSession) => {
      if (task.agentId?._id) {
        router.push({
          pathname: '/(app)/agents/[id]',
          params: { id: task.agentId._id },
        });
      }
    },
    [router],
  );

  const handleViewHistory = useCallback(
    (automation: AutomationDefinition) => {
      router.push({
        pathname: '/(app)/automations/[id]',
        params: { id: automation.id },
      });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: WorkItem }) => (
      <WorkItemRow
        item={item}
        agentName={agentName}
        busyId={controls.busyId}
        onTaskPress={handleTaskPress}
        onToggleAutomation={controls.toggleEnabled}
        onRunAutomation={controls.runNow}
        onStopAutomation={controls.stop}
        onViewAutomationHistory={handleViewHistory}
      />
    ),
    [
      agentName,
      controls.busyId,
      controls.runNow,
      controls.stop,
      controls.toggleEnabled,
      handleTaskPress,
      handleViewHistory,
    ],
  );

  const keyExtractor = useCallback(
    (item: WorkItem) => `${item.kind}:${item.id}`,
    [],
  );

  const ListEmpty = work.isLoading ? (
    <View className="py-12">
      <Loading variant="spinner" size="sm" />
    </View>
  ) : work.isError && work.items.length === 0 ? null : (
    <EmptyState
      icon={RiInbox2Line}
      title={
        work.tab === 'active' ? t('tasks.emptyActive') : t('tasks.emptyHistory')
      }
      description={
        work.tab === 'active' ? t('tasks.emptyActiveHint') : undefined
      }
    />
  );

  const ListFooter = work.hasMoreHistory ? (
    <View className="mt-3 items-center">
      <Button
        tone="neutral"
        appearance="subtle"
        size="sm"
        onPress={work.loadMoreHistory}
      >
        {t('tasks.loadMore')}
      </Button>
    </View>
  ) : null;

  return (
    <FlatList
      className="flex-1"
      data={work.items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ItemSeparatorComponent={TaskSeparator}
      contentContainerClassName="gap-3 px-4 pb-6 pt-4"
      refreshControl={
        <RefreshControl refreshing={work.refreshing} onRefresh={work.refresh} />
      }
      ListHeaderComponent={
        <WorkListHeader
          tab={work.tab}
          onTabChange={work.setTab}
          typeFilter={work.typeFilter}
          onTypeFilterChange={work.setTypeFilter}
          activeCount={work.activeCount}
          isError={work.isError}
          onRetry={() => void work.refresh()}
        />
      }
      ListEmptyComponent={ListEmpty}
      ListFooterComponent={ListFooter}
    />
  );
}
