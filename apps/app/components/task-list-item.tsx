import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Image } from 'expo-image';
import {
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  ChevronRight,
  Ban,
} from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import type { TaskSession } from '@/lib/hooks/use-tasks';

interface TaskListItemProps {
  task: TaskSession;
  onPress?: () => void;
}

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

function getStatusConfig(status: TaskSession['status'], colors: any) {
  switch (status) {
    case 'queued':
      return {
        icon: <Clock size={12} color={colors.mutedForeground} />,
        label: 'Queued',
        color: colors.mutedForeground,
      };
    case 'running':
      return {
        icon: <Loader2 size={12} color="#3b82f6" />,
        label: 'Running',
        color: '#3b82f6',
      };
    case 'completed':
      return {
        icon: <CheckCircle size={12} color="#22c55e" />,
        label: 'Completed',
        color: '#22c55e',
      };
    case 'failed':
      return {
        icon: <XCircle size={12} color="#ef4444" />,
        label: 'Failed',
        color: '#ef4444',
      };
    case 'cancelled':
      return {
        icon: <Ban size={12} color={colors.mutedForeground} />,
        label: 'Cancelled',
        color: colors.mutedForeground,
      };
  }
}

function getPlanProgress(task: TaskSession): number | null {
  if (!task.plan?.items?.length) return null;
  const completed = task.plan.items.filter(i => i.status === 'completed').length;
  return Math.round((completed / task.plan.items.length) * 100);
}

function getTimeLabel(task: TaskSession): string {
  const now = Date.now();

  if (task.status === 'running' && task.stats.startedAt) {
    const elapsed = now - new Date(task.stats.startedAt).getTime();
    return formatDuration(elapsed);
  }

  if (task.stats.completedAt) {
    const ago = now - new Date(task.stats.completedAt).getTime();
    return formatTimeAgo(ago);
  }

  const ago = now - new Date(task.createdAt).getTime();
  return formatTimeAgo(ago);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
