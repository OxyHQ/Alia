import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Image } from 'expo-image';
import { ChevronRight } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import type { TaskSession } from '@/lib/hooks/use-tasks';
import { getStatusConfig, getPlanProgress, getTimeLabel } from '@/lib/task-utils';

interface TaskListItemProps {
  task: TaskSession;
  onPress?: () => void;
}

/** @deprecated Use TaskCard from components/tasks/task-card.tsx instead */
export function TaskListItem({ task, onPress }: TaskListItemProps) {
  const { colors } = useColorScheme();

  const statusConfig = getStatusConfig(task.status, colors);
  const planProgress = getPlanProgress(task);
  const timeLabel = getTimeLabel(task);

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 px-4 py-3 border-b border-border active:bg-muted/50"
    >
      {/* Agent avatar */}
      <View className="w-10 h-10 rounded-full bg-muted items-center justify-center overflow-hidden">
        {task.agentId?.avatar ? (
          <Image source={task.agentId.avatar} style={{ width: 40, height: 40 }} />
        ) : (
          <Text className="text-sm font-medium text-muted-foreground">
            {task.agentId?.name?.charAt(0) || '?'}
          </Text>
        )}
      </View>

      {/* Content */}
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {task.agentId?.name || 'Agent'}
          </Text>
          <View className="flex-row items-center gap-1">
            {statusConfig.icon}
            <Text className="text-xs" style={{ color: statusConfig.color }}>
              {statusConfig.label}
            </Text>
          </View>
        </View>

        <Text className="text-xs text-muted-foreground" numberOfLines={2}>
          {task.task}
        </Text>

        {/* Progress bar for active tasks */}
        {planProgress !== null && (task.status === 'running' || task.status === 'queued') && (
          <View className="flex-row items-center gap-2 mt-1">
            <View className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <View
                className="h-full bg-primary rounded-full"
                style={{ width: `${planProgress}%` }}
              />
            </View>
            <Text className="text-[10px] text-muted-foreground">
              {planProgress}%
            </Text>
          </View>
        )}

        {/* Result preview for completed tasks */}
        {task.result && task.status === 'completed' && (
          <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
            {task.result}
          </Text>
        )}

        {/* Time */}
        <Text className="text-[10px] text-muted-foreground">{timeLabel}</Text>
      </View>

      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}
