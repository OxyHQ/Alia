/**
 * AgentTaskCard — Inline card showing real-time agent execution progress.
 *
 * Renders in the chat interface when an agent is working on a task.
 * Shows: plan checklist, current action, screenshots, elapsed time.
 */

import React, { useState, useEffect } from 'react';
import { View, Pressable, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  FadeIn,
} from 'react-native-reanimated';
import { Check, Circle, Loader, ChevronDown, ChevronUp, Monitor, AlertCircle } from 'lucide-react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import type { AgentActivityState, PlanItem, AgentScreenshot } from '@/lib/hooks/use-agent-activity';

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

function ScreenshotThumbnail({ screenshot }: { screenshot: AgentScreenshot }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable onPress={() => setExpanded(!expanded)}>
      <View className="rounded-lg overflow-hidden border border-border">
        <RNImage
          source={{ uri: `data:image/png;base64,${screenshot.base64}` }}
          style={{ width: expanded ? 320 : 120, height: expanded ? 200 : 75 }}
          resizeMode="cover"
        />
        {!expanded && (
          <View className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
            <Text className="text-[10px] text-white" numberOfLines={1}>
              {screenshot.url}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export const AgentTaskCard = React.memo(function AgentTaskCard({ activity }: AgentTaskCardProps) {
  const { colors } = useTheme();
  const { plan, screenshots, currentAction, isComplete, hasError, lastError, eventCount, startedAt, latestResponse } = activity as any;
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

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <View className="px-3 py-2 border-t border-border">
          <View className="flex-row items-center gap-1 mb-1.5">
            <Monitor size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Browser</Text>
          </View>
          <View className="flex-row gap-2 flex-wrap">
            {screenshots.map((s, i) => (
              <ScreenshotThumbnail key={`ss-${i}`} screenshot={s} />
            ))}
          </View>
        </View>
      )}
    </Animated.View>
  );
});
