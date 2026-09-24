import { AutomationCard } from '@/components/automations/automation-card';
import { TaskCard } from '@/components/tasks/task-card';
import type { AutomationDefinition } from '@/lib/automations/types';
import {
  unifiedWorkItems,
  type WorkItem,
  type WorkTab,
  type WorkTypeFilter,
} from '@/lib/automations/work-items';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useAgentActivity } from '@/lib/hooks/use-agent-activity';
import {
  useAutomationOverview,
  useRunAutomation,
  useSetAutomationEnabled,
  useStopAutomation,
} from '@/lib/hooks/use-automations';
import { useMyAgents } from '@/lib/hooks/use-my-agents';
import {
  useActiveTasks,
  useTaskHistory,
  type TaskSession,
} from '@/lib/hooks/use-tasks';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  AdmonitionButton,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Divider } from '@oxy.so/bloom/divider';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiInbox2Line } from '@oxy.so/bloom/icons/RiInbox2Line';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

/**
 * The one place work is seen and managed (#537).
 *
 * Sessions agents run and the automations that start them are merged into a
 * single list by `unifiedWorkItems`, which documents the tab semantics and
 * the order. Automations reach this page through the same overview query the
 * create dialog invalidates, so a new one appears here without a reload; its
 * controls (pause/resume, run now, history) are the ones the Automations page
 * used to host.
 */

/** Wrapper that subscribes to real-time activity for a single active task */
function ActiveTaskCard({
  task,
  onPress,
}: {
  task: TaskSession;
  onPress: () => void;
}) {
  const activity = useAgentActivity(
    task.status === 'running' ? task._id : null,
    task.agentId?._id ?? null,
  );
  return <TaskCard task={task} activity={activity} onPress={onPress} />;
}

function TaskSeparator() {
  return <Divider />;
}

const TYPE_FILTERS: ReadonlyArray<{ value: WorkTypeFilter; key: string }> = [
  { value: 'all', key: 'tasks.filterAll' },
  { value: 'tasks', key: 'tasks.filterTasks' },
  { value: 'automations', key: 'tasks.filterAutomations' },
];

export default function TasksPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState<WorkTab>('active');
  const [typeFilter, setTypeFilter] = useState<WorkTypeFilter>('all');
  const [historyPage, setHistoryPage] = useState(1);

  const activeTasks = useActiveTasks();
  const taskHistory = useTaskHistory(historyPage);
  const overview = useAutomationOverview();
  const agents = useMyAgents();
  const setEnabled = useSetAutomationEnabled();
  const stopAutomation = useStopAutomation();
  const runAutomation = useRunAutomation();
  const [busyId, setBusyId] = useState<string | null>(null);

  const agentNames = useMemo(
    () =>
      new Map(
        (agents.data ?? []).map((agent) => [
          agent._id,
          agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
        ]),
      ),
    [agents.data],
  );
  const agentName = useCallback(
    (agentId: string) =>
      agentNames.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`,
    [agentNames],
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      activeTasks.refetch(),
      taskHistory.refetch(),
      overview.refetch(),
    ]);
    setRefreshing(false);
  }, [activeTasks, taskHistory, overview]);

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

  const handleToggleEnabled = useCallback(
    async (automation: AutomationDefinition, enabled: boolean) => {
      setBusyId(automation.id);
      try {
        const result = await setEnabled.mutateAsync({ automation, enabled });
        if (result.revocation?.failed) {
          toast.error(
            `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
          );
        }
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, 'Failed to update automation'));
      } finally {
        setBusyId(null);
      }
    },
    [setEnabled],
  );

  const handleStop = useCallback(
    async (automation: AutomationDefinition) => {
      setBusyId(automation.id);
      try {
        const result = await stopAutomation.mutateAsync(automation);
        if (result.revocation?.failed) {
          toast.error(
            `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
          );
        } else {
          toast.success('Automation stopped and access revoked');
        }
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, 'Failed to stop automation'));
      } finally {
        setBusyId(null);
      }
    },
    [stopAutomation],
  );

  const handleRunNow = useCallback(
    async (automation: AutomationDefinition) => {
      setBusyId(automation.id);
      try {
        await runAutomation.mutateAsync(automation);
        toast.success('Automation queued');
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, 'Automation run failed'));
      } finally {
        setBusyId(null);
      }
    },
    [runAutomation],
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

  const automations = overview.data?.automations ?? [];
  const runs = overview.data?.runs ?? [];
  const activeSessions = activeTasks.data?.sessions ?? [];
  const historySessions = taskHistory.data?.sessions ?? [];

  // The badge counts the unified active list, whichever tab or filter is shown.
  const activeItems = useMemo(
    () =>
      unifiedWorkItems({
        tasks: activeSessions,
        automations,
        runs,
        tab: 'active',
      }),
    [activeSessions, automations, runs],
  );
  const items = useMemo(
    () =>
      tab === 'active' && typeFilter === 'all'
        ? activeItems
        : unifiedWorkItems({
            tasks: tab === 'active' ? activeSessions : historySessions,
            automations,
            runs,
            tab,
            typeFilter,
          }),
    [
      tab,
      typeFilter,
      activeItems,
      activeSessions,
      historySessions,
      automations,
      runs,
    ],
  );
  const activeCount = activeItems.length;

  const sourceLoading =
    activeTasks.isLoading ||
    overview.isLoading ||
    (tab === 'history' && taskHistory.isLoading);
  const isLoading = sourceLoading && items.length === 0;
  const isError =
    activeTasks.isError ||
    overview.isError ||
    (tab === 'history' && taskHistory.isError);

  const renderItem = useCallback(
    ({ item }: { item: WorkItem }) => {
      if (item.kind === 'task') {
        return item.task.status === 'running' ||
          item.task.status === 'queued' ? (
          <ActiveTaskCard
            task={item.task}
            onPress={() => handleTaskPress(item.task)}
          />
        ) : (
          <TaskCard
            task={item.task}
            onPress={() => handleTaskPress(item.task)}
          />
        );
      }
      return (
        <AutomationCard
          variant="compact"
          automation={item.automation}
          latestRun={item.latestRun}
          agentName={agentName}
          busy={busyId === item.id}
          controlsDisabled={busyId !== null}
          onToggle={handleToggleEnabled}
          onRun={handleRunNow}
          onStop={handleStop}
          onViewHistory={handleViewHistory}
        />
      );
    },
    [
      agentName,
      busyId,
      handleRunNow,
      handleStop,
      handleTaskPress,
      handleToggleEnabled,
      handleViewHistory,
    ],
  );

  const keyExtractor = useCallback(
    (item: WorkItem) => `${item.kind}:${item.id}`,
    [],
  );

  const ListEmpty = isLoading ? (
    <View className="py-12">
      <Loading variant="spinner" size="sm" />
    </View>
  ) : isError && items.length === 0 ? null : (
    <EmptyState
      icon={RiInbox2Line}
      title={
        tab === 'active' ? t('tasks.emptyActive') : t('tasks.emptyHistory')
      }
      description={tab === 'active' ? t('tasks.emptyActiveHint') : undefined}
    />
  );

  const ListHeader = (
    // Stacking only: the view switch, the type filter and the error block.
    <View className="gap-3 pb-1">
      <View className="flex-row flex-wrap items-center gap-3">
        <SegmentedControl
          label={t('pages.tasks.view')}
          type="tabs"
          value={tab}
          onValueChange={setTab}
        >
          <SegmentedControlItem value="active">
            <SegmentedControlItemText>
              {t('tasks.active')}
            </SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="history">
            <SegmentedControlItemText>
              {t('tasks.history')}
            </SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
        {/* The badge counts the unified active list, whichever tab is shown. */}
        {activeCount > 0 ? (
          <Badge
            size="label-small"
            variant="solid"
            color="primary"
            content={t('tasks.activeCount', { count: activeCount })}
          />
        ) : null}

        {/* Type filter: narrows the unified list, never replaces it. */}
        <ChipRow
          role="radiogroup"
          accessibilityLabel={t('pages.tasks.typeFilter')}
        >
          {TYPE_FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              size="xl"
              role="radio"
              accessibilityLabel={t(filter.key)}
              selected={typeFilter === filter.value}
              onPress={() => setTypeFilter(filter.value)}
            >
              {t(filter.key)}
            </Chip>
          ))}
        </ChipRow>
      </View>

      {isError ? (
        <AdmonitionRoot type="error">
          <AdmonitionRow>
            <AdmonitionIcon />
            <AdmonitionContent>
              <AdmonitionText>{t('tasks.loadError')}</AdmonitionText>
              <AdmonitionButton
                tone="neutral"
                appearance="subtle"
                onPress={() => void onRefresh()}
              >
                {t('tasks.retry')}
              </AdmonitionButton>
            </AdmonitionContent>
          </AdmonitionRow>
        </AdmonitionRoot>
      ) : null}
    </View>
  );

  const ListFooter =
    tab === 'history' &&
    taskHistory.data &&
    taskHistory.data.total > historyPage * 20 ? (
      <View className="mt-3 items-center">
        <Button
          tone="neutral"
          appearance="subtle"
          size="sm"
          onPress={() => setHistoryPage((p) => p + 1)}
        >
          {t('tasks.loadMore')}
        </Button>
      </View>
    ) : null;

  return (
    <FlatList
      className="flex-1"
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ItemSeparatorComponent={TaskSeparator}
      contentContainerClassName="gap-3 px-4 pb-6 pt-4"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
      ListHeaderComponent={ListHeader}
      ListEmptyComponent={ListEmpty}
      ListFooterComponent={ListFooter}
    />
  );
}
