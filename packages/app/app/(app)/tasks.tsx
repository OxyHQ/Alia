import { useState, useCallback } from 'react';
import { View, FlatList, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { ListTodo, Inbox } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import { useActiveTasks, useTaskHistory, type TaskSession } from '@/lib/hooks/use-tasks';
import { useAgentActivity } from '@/lib/hooks/use-agent-activity';
import { TaskCard } from '@/components/tasks/task-card';
import { useRouter } from 'expo-router';

type Tab = 'active' | 'history';

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

export default function TasksPage() {
  const { colors } = useColorScheme();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('active');
  const [historyPage, setHistoryPage] = useState(1);

  const activeTasks = useActiveTasks();
  const taskHistory = useTaskHistory(historyPage);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([activeTasks.refetch(), taskHistory.refetch()]);
    setRefreshing(false);
  }, [activeTasks, taskHistory]);

  const handleTaskPress = useCallback((task: TaskSession) => {
    if (task.agentId?._id) {
      router.push({ pathname: "/(app)/agents/[id]", params: { id: task.agentId._id } });
    }
  }, [router]);

  const activeCount = activeTasks.data?.sessions?.length ?? 0;
  const sessions = tab === 'active'
    ? (activeTasks.data?.sessions ?? [])
    : (taskHistory.data?.sessions ?? []);
  const isLoading = tab === 'active' ? activeTasks.isLoading : taskHistory.isLoading;

  const renderActiveItem = useCallback(({ item }: { item: TaskSession }) => (
    <ActiveTaskCard task={item} onPress={() => handleTaskPress(item)} />
  ), [handleTaskPress]);

  const renderHistoryItem = useCallback(({ item }: { item: TaskSession }) => (
    <TaskCard task={item} onPress={() => handleTaskPress(item)} />
  ), [handleTaskPress]);

  const keyExtractor = useCallback((item: TaskSession) => item._id, []);

  const ListEmpty = isLoading ? null : (
    <View className="items-center justify-center py-16 gap-3">
      <Inbox size={40} color={colors.mutedForeground} />
      <Text className="text-sm text-muted-foreground">
        {tab === 'active' ? 'No active tasks' : 'No completed tasks yet'}
      </Text>
      {tab === 'active' && (
        <Text className="text-xs text-muted-foreground text-center px-8">
          Hire an agent from the Agents page to start a task. Tasks run in the background and you can track their progress here.
        </Text>
      )}
    </View>
  );

  const ListFooter = tab === 'history' && taskHistory.data && taskHistory.data.total > historyPage * 20 ? (
    <View className="items-center py-6">
      <Button
        variant="ghost"
        size="sm"
        onPress={() => setHistoryPage(p => p + 1)}
      >
        <Text className="text-xs text-foreground">Load more</Text>
      </Button>
    </View>
  ) : null;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-5 pt-4 pb-2 border-b border-border">
        <View className="flex-row items-center gap-2 mb-3">
          <ListTodo size={20} color={colors.foreground} />
          <Text className="text-lg font-semibold text-foreground">Tasks</Text>
          {activeCount > 0 && (
            <View className="bg-primary rounded-full px-2 py-0.5 ml-1">
              <Text className="text-[10px] font-medium text-primary-foreground">
                {activeCount} active
              </Text>
            </View>
          )}
        </View>

        {/* Tabs */}
        <View className="flex-row gap-2">
          <Button
            variant={tab === 'active' ? 'default' : 'outline'}
            size="sm"
            className="rounded-full"
            onPress={() => setTab('active')}
          >
            <Text className={tab === 'active' ? 'text-primary-foreground text-xs' : 'text-foreground text-xs'}>
              Active
            </Text>
          </Button>
          <Button
            variant={tab === 'history' ? 'default' : 'outline'}
            size="sm"
            className="rounded-full"
            onPress={() => setTab('history')}
          >
            <Text className={tab === 'history' ? 'text-primary-foreground text-xs' : 'text-foreground text-xs'}>
              History
            </Text>
          </Button>
        </View>
      </View>

      {/* Task Timeline */}
      <FlatList
        data={sessions}
        keyExtractor={keyExtractor}
        renderItem={tab === 'active' ? renderActiveItem : renderHistoryItem}
        ItemSeparatorComponent={TaskSeparator}
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 24 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={ListEmpty}
        ListFooterComponent={ListFooter}
      />
    </View>
  );
}
