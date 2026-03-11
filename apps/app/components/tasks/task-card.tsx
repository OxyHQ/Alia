import React, { useState, useEffect, useMemo } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ChevronDown, ChevronUp, Loader } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import type { TaskSession } from '@/lib/hooks/use-tasks';
import type { AgentActivityState } from '@/lib/hooks/use-agent-activity';
import { AgentAvatarRow } from './agent-avatar-row';
import { TaskTimelineStep } from './task-timeline-step';
import { getStatusConfig, formatDuration, getToolPillLabel } from '@/lib/task-utils';

interface TaskCardProps {
  task: TaskSession;
  activity?: AgentActivityState | null;
  onPress?: () => void;
}

const COLLAPSED_STEP_COUNT = 5;

export const TaskCard = React.memo(function TaskCard({
  task,
  activity,
  onPress,
}: TaskCardProps) {
  const { colors } = useColorScheme();
  const statusConfig = getStatusConfig(task.status, colors);
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState('');

  // Elapsed timer for running tasks
  useEffect(() => {
    const startedAt = task.stats.startedAt;
    if (task.status !== 'running' || !startedAt) {
      if (startedAt) setElapsed(formatDuration(Date.now() - new Date(startedAt).getTime()));
      return;
    }
    const update = () => setElapsed(formatDuration(Date.now() - new Date(startedAt).getTime()));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [task.status, task.stats.startedAt]);

  // Merge real-time plan with static plan
  const planItems = useMemo(() => {
    if (activity?.plan?.items?.length) return activity.plan.items;
    return task.plan?.items ?? [];
  }, [activity?.plan?.items, task.plan?.items]);

  const completedCount = planItems.filter(i => i.status === 'completed').length;
  const totalCount = planItems.length;
  const hasTimeline = totalCount > 0;
  const needsCollapse = totalCount > COLLAPSED_STEP_COUNT;
  const visibleItems = needsCollapse && !expanded
    ? planItems.slice(0, COLLAPSED_STEP_COUNT)
    : planItems;

  // Current tool info for the in-progress step
  const currentToolName = activity?.currentAction?.toolName ?? null;
  const currentToolLabel = currentToolName ? getToolPillLabel(currentToolName) : null;

  // Build agents list for avatar row
  const agents = useMemo(() => {
    const list: Array<{ _id: string; name: string; avatar?: string }> = [];
    if (task.agentId) {
      list.push({ _id: task.agentId._id, name: task.agentId.name, avatar: task.agentId.avatar });
    }
    if (task.childAgents?.length) {
      for (const child of task.childAgents) {
        if (!list.some(a => a._id === child._id)) {
          list.push({ _id: child._id, name: child.name, avatar: child.avatar });
        }
      }
    }
    return list;
  }, [task.agentId, task.childAgents]);

  return (
    <Animated.View entering={FadeIn.duration(300)}>
      <Pressable onPress={onPress} className="active:opacity-70">
        {/* Header: agent avatars + status badge + elapsed time */}
        <View className="flex-row items-center justify-between mb-2">
          <AgentAvatarRow agents={agents} />
          <View className="flex-row items-center gap-2">
            {elapsed ? (
              <Text className="text-xs text-muted-foreground">{elapsed}</Text>
            ) : null}
            <View className="flex-row items-center gap-1 bg-muted/50 rounded-full px-2 py-0.5">
              {statusConfig.icon}
              <Text className="text-[10px] font-medium" style={{ color: statusConfig.color }}>
                {statusConfig.label}
              </Text>
            </View>
          </View>
        </View>

        {/* Task description */}
        <Text className="text-sm text-muted-foreground mb-3" numberOfLines={2}>
          {task.task}
        </Text>

        {/* Timeline steps — matches thought-panel StepsTab pattern */}
        {hasTimeline && (
          <View className="gap-0">
            {visibleItems.map((item, i) => (
              <TaskTimelineStep
                key={item.id}
                item={item}
                isLast={i === visibleItems.length - 1 && (expanded || !needsCollapse)}
                toolName={item.status === 'in_progress' ? currentToolName : null}
                toolLabel={item.status === 'in_progress' ? currentToolLabel : null}
              />
            ))}

            {needsCollapse && (
              <Pressable
                onPress={() => setExpanded(!expanded)}
                className="flex-row items-center gap-1.5 mt-1"
                style={{ marginLeft: 26 }}
              >
                {expanded ? (
                  <ChevronUp size={12} color={colors.mutedForeground} />
                ) : (
                  <ChevronDown size={12} color={colors.mutedForeground} />
                )}
                <Text className="text-xs text-muted-foreground">
                  {expanded ? 'Show less' : `Show all ${totalCount} steps`}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Current action (when no plan yet) */}
        {!hasTimeline && activity?.currentAction && task.status === 'running' && (
          <View className="flex-row items-center gap-2 bg-muted/40 rounded-full px-3 py-1.5 self-start">
            <Loader size={12} color={colors.mutedForeground} />
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {getToolPillLabel(activity.currentAction.toolName)}
            </Text>
          </View>
        )}

        {/* Result preview for completed tasks */}
        {task.result && task.status === 'completed' && !hasTimeline && (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {task.result}
          </Text>
        )}

        {/* Footer: step count */}
        {hasTimeline && (
          <Text className="text-xs text-muted-foreground mt-2" style={{ marginLeft: 26 }}>
            {completedCount}/{totalCount} steps completed
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
});
