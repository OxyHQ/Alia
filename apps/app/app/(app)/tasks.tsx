import { useState, useCallback } from 'react';
import { View, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { ListTodo, Inbox } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import { useActiveTasks, useTaskHistory, type TaskSession } from '@/lib/hooks/use-tasks';
import { TaskListItem } from '@/components/task-list-item';
import { useRouter } from 'expo-router';

type Tab = 'active' | 'history';

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

  const handleTaskPress = (task: TaskSession) => {
    // Navigate to the agent session detail (could link to chat or a dedicated view)
    if (task.agentId?._id) {
      router.push(`/(app)/agents/${task.agentId._id}` as any);
    }
  };

  const activeCount = activeTasks.data?.sessions?.length ?? 0;
  const sessions = tab === 'active'
    ? (activeTasks.data?.sessions ?? [])
    : (taskHistory.data?.sessions ?? []);
  const isLoading = tab === 'active' ? activeTasks.isLoading : taskHistory.isLoading;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 pt-4 pb-2 border-b border-border">
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

      {/* Task List */}
      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {isLoading ? (
          <View className="items-center justify-center py-12">
            <ActivityIndicator size="small" color={colors.foreground} />
          </View>
        ) : sessions.length === 0 ? (
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
        ) : (
          <>
            {sessions.map((task) => (
              <TaskListItem
                key={task._id}
                task={task}
                onPress={() => handleTaskPress(task)}
              />
            ))}

            {/* Pagination for history */}
            {tab === 'history' && taskHistory.data && taskHistory.data.total > historyPage * 20 && (
              <View className="items-center py-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setHistoryPage(p => p + 1)}
                >
                  <Text className="text-xs text-foreground">Load more</Text>
                </Button>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
