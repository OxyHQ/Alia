import {
  unifiedWorkItems,
  type WorkTab,
  type WorkTypeFilter,
} from '@/lib/automations/work-items';
import { useAutomationOverview } from '@/lib/hooks/use-automations';
import { useActiveTasks, useTaskHistory } from '@/lib/hooks/use-tasks';
import { useCallback, useMemo, useState } from 'react';

/** How many history sessions one page of `useTaskHistory` holds. */
const HISTORY_PAGE_SIZE = 20;

/**
 * The work page's list: agent sessions and the automations that start them,
 * merged by `unifiedWorkItems` for the tab and type filter shown.
 *
 * The three sources are loaded and refreshed together, and "loading" and
 * "failed" are asked of the sources the current tab actually reads — the
 * history is not waited on while the active tab is shown.
 */
export function useWorkList() {
  const [tab, setTab] = useState<WorkTab>('active');
  const [typeFilter, setTypeFilter] = useState<WorkTypeFilter>('all');
  const [historyPage, setHistoryPage] = useState(1);

  const activeTasks = useActiveTasks();
  const taskHistory = useTaskHistory(historyPage, HISTORY_PAGE_SIZE);
  const overview = useAutomationOverview();

  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      activeTasks.refetch(),
      taskHistory.refetch(),
      overview.refetch(),
    ]);
    setRefreshing(false);
  }, [activeTasks, taskHistory, overview]);

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

  const sourceLoading =
    activeTasks.isLoading ||
    overview.isLoading ||
    (tab === 'history' && taskHistory.isLoading);
  const isError =
    activeTasks.isError ||
    overview.isError ||
    (tab === 'history' && taskHistory.isError);
  const hasMoreHistory =
    tab === 'history' &&
    taskHistory.data !== undefined &&
    taskHistory.data.total > historyPage * HISTORY_PAGE_SIZE;

  return {
    tab,
    setTab,
    typeFilter,
    setTypeFilter,
    items,
    activeCount: activeItems.length,
    isLoading: sourceLoading && items.length === 0,
    isError,
    refreshing,
    refresh,
    hasMoreHistory,
    loadMoreHistory: () => setHistoryPage((page) => page + 1),
  };
}
