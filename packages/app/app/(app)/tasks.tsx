import { useState, useCallback, useMemo } from 'react';
import { View, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { DrawerToggle } from '@/components/ui/drawer-toggle';
import { ListTodo, Inbox } from 'lucide-react-native';
import { toast } from '@oxy.so/bloom/toast';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/lib/hooks/use-translation';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useActiveTasks, useTaskHistory, type TaskSession } from '@/lib/hooks/use-tasks';
import { useAgentActivity } from '@/lib/hooks/use-agent-activity';
import {
  useAutomationOverview,
  useRunAutomation,
  useSetAutomationEnabled,
  useStopAutomation,
} from '@/lib/hooks/use-automations';
import { useMyAgents } from '@/lib/hooks/use-my-agents';
import { TaskCard } from '@/components/tasks/task-card';
import { AutomationCard } from '@/components/automations/automation-card';
import type { AutomationDefinition } from '@/lib/automations/types';
import {
  unifiedWorkItems,
  type WorkItem,
  type WorkTab,
  type WorkTypeFilter,
} from '@/lib/automations/work-items';
import { useRouter } from 'expo-router';
import { ContentPanel } from "@oxy.so/bloom/content-panel";

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
function ActiveTaskCard({ task, onPress }: { task: TaskSession; onPress: () => void }) {
  const activity = useAgentActivity(
    task.status === 'running' ? task._id : null,
    task.agentId?._id ?? null,
  );
  return <TaskCard task={task} activity={activity} onPress={onPress} />;
}

function TaskSeparator() {
  return <View className="h-px bg-border my-6" />;
}

const TYPE_FILTERS: ReadonlyArray<{ value: WorkTypeFilter; key: string }> = [
  { value: 'all', key: 'tasks.filterAll' },
  { value: 'tasks', key: 'tasks.filterTasks' },
  { value: 'automations', key: 'tasks.filterAutomations' },
];

export default function TasksPage() {
  const { colors } = useColorScheme();
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
    () => new Map((agents.data ?? []).map((agent) => [
      agent._id,
      agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
    ])),
    [agents.data],
  );
  const agentName = useCallback(
    (agentId: string) => agentNames.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`,
    [agentNames],
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([activeTasks.refetch(), taskHistory.refetch(), overview.refetch()]);
    setRefreshing(false);
  }, [activeTasks, taskHistory, overview]);

  const handleTaskPress = useCallback((task: TaskSession) => {
    if (task.agentId?._id) {
      router.push({ pathname: "/(app)/agents/[id]", params: { id: task.agentId._id } });
    }
  }, [router]);

  const handleToggleEnabled = useCallback(async (automation: AutomationDefinition, enabled: boolean) => {
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
  }, [setEnabled]);

  const handleStop = useCallback(async (automation: AutomationDefinition) => {
    setBusyId(automation.id);
    try {
      const result = await stopAutomation.mutateAsync(automation);
      if (result.revocation?.failed) {
        toast.error(
          `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
        );
      } else {
        toast.success(
          automation.legacyTriggerId ? 'Automation stopped' : 'Automation stopped and access revoked',
        );
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to stop automation'));
    } finally {
      setBusyId(null);
    }
  }, [stopAutomation]);

  const handleRunNow = useCallback(async (automation: AutomationDefinition) => {
    setBusyId(automation.id);
    try {
      await runAutomation.mutateAsync(automation);
      toast.success(automation.legacyTriggerId ? 'Automation completed' : 'Automation queued');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Automation run failed'));
    } finally {
      setBusyId(null);
    }
  }, [runAutomation]);

  const handleViewHistory = useCallback((automation: AutomationDefinition) => {
    router.push({
      pathname: '/(app)/automations/[id]',
      params: { id: automation.id },
    });
  }, [router]);

  const automations = overview.data?.automations ?? [];
  const runs = overview.data?.runs ?? [];
  const activeSessions = activeTasks.data?.sessions ?? [];
  const historySessions = taskHistory.data?.sessions ?? [];

  // The badge counts the unified active list, whichever tab or filter is shown.
  const activeItems = useMemo(
    () => unifiedWorkItems({ tasks: activeSessions, automations, runs, tab: 'active' }),
    [activeSessions, automations, runs],
  );
  const items = useMemo(
    () => (tab === 'active' && typeFilter === 'all'
      ? activeItems
      : unifiedWorkItems({
        tasks: tab === 'active' ? activeSessions : historySessions,
        automations,
        runs,
        tab,
        typeFilter,
      })),
    [tab, typeFilter, activeItems, activeSessions, historySessions, automations, runs],
  );
  const activeCount = activeItems.length;

  const sourceLoading = activeTasks.isLoading
    || overview.isLoading
    || (tab === 'history' && taskHistory.isLoading);
  const isLoading = sourceLoading && items.length === 0;
  const isError = activeTasks.isError || overview.isError || (tab === 'history' && taskHistory.isError);

  const renderItem = useCallback(({ item }: { item: WorkItem }) => {
    if (item.kind === 'task') {
      return item.task.status === 'running' || item.task.status === 'queued'
        ? <ActiveTaskCard task={item.task} onPress={() => handleTaskPress(item.task)} />
        : <TaskCard task={item.task} onPress={() => handleTaskPress(item.task)} />;
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
  }, [agentName, busyId, handleRunNow, handleStop, handleTaskPress, handleToggleEnabled, handleViewHistory]);

  const keyExtractor = useCallback((item: WorkItem) => `${item.kind}:${item.id}`, []);

  const ListEmpty = isLoading ? (
    <View className="items-center justify-center py-16">
      <ActivityIndicator size="small" color={colors.mutedForeground} />
    </View>
  ) : isError && items.length === 0 ? null : (
    <View className="items-center justify-center py-16 gap-3">
      <Inbox size={40} color={colors.mutedForeground} />
      <Text className="text-sm text-muted-foreground text-center px-8">
        {tab === 'active' ? t('tasks.emptyActive') : t('tasks.emptyHistory')}
      </Text>
      {tab === 'active' && (
        <Text className="text-xs text-muted-foreground text-center px-8">
          {t('tasks.emptyActiveHint')}
        </Text>
      )}
    </View>
  );

  const ListHeader = isError ? (
    <View className="mb-6 rounded-2xl border border-border bg-surface p-4 gap-3 items-start">
      <Text className="text-sm text-muted-foreground" selectable>{t('tasks.loadError')}</Text>
      <Button variant="outline" size="sm" onPress={() => void onRefresh()}>
        <Text className="text-xs text-foreground">{t('tasks.retry')}</Text>
      </Button>
    </View>
  ) : null;

  const ListFooter = tab === 'history' && taskHistory.data && taskHistory.data.total > historyPage * 20 ? (
    <View className="items-center py-6">
      <Button
        variant="ghost"
        size="sm"
        onPress={() => setHistoryPage(p => p + 1)}
      >
        <Text className="text-xs text-foreground">{t('tasks.loadMore')}</Text>
      </Button>
    </View>
  ) : null;

  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="flex-1 bg-background">
        {/* Header */}
        <View className="px-5 pt-4 pb-2 border-b border-border">
          <View className="flex-row items-center gap-2 mb-3">
            <DrawerToggle className="-ml-2" />
            <ListTodo size={20} color={colors.foreground} />
            <Text className="text-lg font-semibold text-foreground">{t('tasks.title')}</Text>
            {activeCount > 0 && (
              <View className="bg-primary rounded-full px-2 py-0.5 ml-1">
                <Text className="text-[10px] font-medium text-primary-foreground">
                  {t('tasks.activeCount', { count: activeCount })}
                </Text>
              </View>
            )}
          </View>

          {/* Tabs */}
          <View className="flex-row flex-wrap items-center gap-2">
            <Button
              variant={tab === 'active' ? 'default' : 'outline'}
              size="sm"
              className="rounded-full"
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === 'active' }}
              onPress={() => setTab('active')}
            >
              <Text className={tab === 'active' ? 'text-primary-foreground text-xs' : 'text-foreground text-xs'}>
                {t('tasks.active')}
              </Text>
            </Button>
            <Button
              variant={tab === 'history' ? 'default' : 'outline'}
              size="sm"
              className="rounded-full"
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === 'history' }}
              onPress={() => setTab('history')}
            >
              <Text className={tab === 'history' ? 'text-primary-foreground text-xs' : 'text-foreground text-xs'}>
                {t('tasks.history')}
              </Text>
            </Button>

            {/* Type filter: narrows the unified list, never replaces it. */}
            <View className="flex-row items-center gap-1 ml-auto">
              {TYPE_FILTERS.map((filter) => (
                <Button
                  key={filter.value}
                  variant="ghost"
                  size="sm"
                  className={`rounded-full ${typeFilter === filter.value ? 'bg-muted' : ''}`}
                  accessibilityRole="button"
                  accessibilityLabel={t(filter.key)}
                  accessibilityState={{ selected: typeFilter === filter.value }}
                  onPress={() => setTypeFilter(filter.value)}
                >
                  <Text className={typeFilter === filter.value ? 'text-foreground text-xs' : 'text-muted-foreground text-xs'}>
                    {t(filter.key)}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </View>

        {/* Unified work list */}
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ItemSeparatorComponent={TaskSeparator}
          contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={ListEmpty}
          ListFooterComponent={ListFooter}
        />
      </View>
    </ContentPanel>
  );
}
