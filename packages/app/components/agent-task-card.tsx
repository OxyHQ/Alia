/**
 * AgentTaskCard — Inline card showing real-time agent execution progress.
 *
 * Renders in the chat interface when an agent is working on a task.
 * Shows: plan checklist, current action, elapsed time.
 */

import React, { useState, useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  FadeIn,
} from 'react-native-reanimated';
import { Check, Circle, Loader, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import type { AgentActivityState, PlanItem } from '@/lib/hooks/use-agent-activity';

interface AgentTaskCardProps {
  activity: AgentActivityState;
}

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 600 }),
        withTiming(1, { duration: 600 }),
      ),
      -1,
    );
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[style, { width: 8, height: 8, borderRadius: 4, backgroundColor: color }]} />
  );
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '';
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function PlanItemRow({ item }: { item: PlanItem }) {
  const { colors } = useTheme();
  const isCompleted = item.status === 'completed';
  const isInProgress = item.status === 'in_progress';

  return (
    <View className="flex-row items-start gap-2 py-0.5">
      {isCompleted ? (
        <Check size={14} className="text-green-500 mt-0.5" />
      ) : isInProgress ? (
        <PulsingDot color={colors.warning} />
      ) : (
        <Circle size={14} className="text-muted-foreground mt-0.5" />
      )}
      <Text
        className={`text-sm flex-1 ${isCompleted ? 'text-muted-foreground line-through' : 'text-foreground'}`}
      >
        {item.text}
      </Text>
    </View>
  );
}

export const AgentTaskCard = React.memo(function AgentTaskCard({ activity }: AgentTaskCardProps) {
  const { colors } = useTheme();
  const { plan, currentAction, isComplete, hasError, lastError, eventCount, startedAt, latestResponse } = activity;
  const [showPlan, setShowPlan] = useState(true);
  const [elapsed, setElapsed] = useState('');

  // Update elapsed time
  useEffect(() => {
    if (!startedAt || isComplete) {
      if (startedAt) setElapsed(formatElapsed(startedAt));
      return;
    }
    const interval = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(interval);
  }, [startedAt, isComplete]);

  // Nothing to show yet
  if (!plan && !currentAction && eventCount === 0) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      className="rounded-xl border border-border bg-surface/50 overflow-hidden my-1"
    >
      {/* Header */}
      <View className="flex-row items-center justify-between px-3 py-2 border-b border-border">
        <View className="flex-row items-center gap-2">
          {isComplete ? (
            <Check size={14} className="text-green-500" />
          ) : hasError ? (
            <AlertCircle size={14} className="text-red-500" />
          ) : (
            <PulsingDot color={colors.info} />
          )}
          <Text className="text-xs font-semibold text-foreground">
            {isComplete ? 'Task Complete' : hasError ? 'Error' : 'Agent Working'}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          {elapsed ? (
            <Text className="text-xs text-muted-foreground">{elapsed}</Text>
          ) : null}
          {plan && plan.total > 0 && (
            <Text className="text-xs text-muted-foreground">
              {plan.completed}/{plan.total}
            </Text>
          )}
        </View>
      </View>

      {/* Progress bar */}
      {plan && plan.total > 0 && (
        <View className="h-1 bg-muted">
          <View
            className="h-1 bg-primary"
            style={{ width: `${Math.round((plan.completed / plan.total) * 100)}%` }}
          />
        </View>
      )}

      {/* Plan checklist */}
      {plan && plan.items.length > 0 && (
        <View className="px-3 pt-2">
          <Pressable
            onPress={() => setShowPlan(!showPlan)}
            className="flex-row items-center gap-1 mb-1"
          >
            {showPlan ? (
              <ChevronUp size={12} className="text-muted-foreground" />
            ) : (
              <ChevronDown size={12} className="text-muted-foreground" />
            )}
            <Text className="text-xs font-medium text-muted-foreground">Plan</Text>
          </Pressable>
          {showPlan && (
            <View className="gap-0.5 pb-1">
              {plan.items.map(item => (
                <PlanItemRow key={item.id} item={item} />
              ))}
            </View>
          )}
        </View>
      )}

      {/* Current action */}
      {currentAction && !isComplete && (
        <View className="flex-row items-center gap-2 px-3 py-2 border-t border-border">
          <Loader size={12} className="text-yellow-500" />
          <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
            <Text className="font-semibold">{currentAction.toolName}</Text>
            {' '}
            {currentAction.content.length > 80
              ? currentAction.content.slice(0, 80) + '...'
              : currentAction.content}
          </Text>
        </View>
      )}

      {/* Agent response */}
      {latestResponse && !isComplete && (
        <View className="px-3 py-2 border-t border-border">
          <Text className="text-xs text-muted-foreground" numberOfLines={4}>
            {latestResponse.length > 200 ? latestResponse.slice(0, 200) + '...' : latestResponse}
          </Text>
        </View>
      )}

      {/* Error message */}
      {hasError && lastError && (
        <View className="px-3 py-2 border-t border-border">
          <Text className="text-xs text-red-400" numberOfLines={2}>
            {lastError}
          </Text>
        </View>
      )}
    </Animated.View>
  );
});
