import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  FadeIn,
} from 'react-native-reanimated';
import { CheckCircle2, Circle, AlertCircle } from 'lucide-react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { getToolIcon } from '@/lib/tool-registry';
import { LottieLoader } from '@/components/lottie-loader';
import type { PlanItem } from '@/lib/hooks/use-agent-activity';

interface TaskTimelineStepProps {
  item: PlanItem;
  isLast: boolean;
  toolName?: string | null;
  toolLabel?: string | null;
}

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 800 }),
        withTiming(1, { duration: 800 }),
      ),
      -1,
      false,
    );
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, style]}
    />
  );
}

function StepIcon({ item, toolName }: { item: PlanItem; toolName?: string | null }) {
  const { colors } = useTheme();
  if (item.status === 'completed') {
    return <CheckCircle2 size={14} color={colors.success} />;
  }
  if (item.status === 'in_progress') {
    if (toolName) {
      return <LottieLoader width={14} height={14} />;
    }
    return <PulsingDot color={colors.warning} />;
  }
  if (item.status === 'blocked') {
    return <AlertCircle size={14} color={colors.error} />;
  }
  return <Circle size={14} className="text-muted-foreground/30" />;
}

export const TaskTimelineStep = React.memo(function TaskTimelineStep({
  item,
  isLast,
  toolName,
  toolLabel,
}: TaskTimelineStepProps) {
  const isActive = item.status === 'in_progress';
  const isDone = item.status === 'completed';

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-row">
      {/* Timeline column */}
      <View className="items-center" style={{ width: 24 }}>
        <View className="h-3" />
        <View className="items-center justify-center" style={{ width: 20, height: 20 }}>
          <StepIcon item={item} toolName={toolName} />
        </View>
        {!isLast && (
          <View
            className="flex-1 border-l border-border"
            style={{ minHeight: 16 }}
          />
        )}
      </View>

      {/* Content column */}
      <View className="flex-1 pl-2 pb-3" style={{ paddingTop: 12 }}>
        <Text
          className={`text-sm ${
            isDone
              ? 'text-foreground font-medium'
              : isActive
                ? 'text-foreground font-medium'
                : 'text-muted-foreground'
          }`}
        >
          {item.text}
        </Text>

        {/* Tool pill for active step */}
        {isActive && toolLabel && (
          <View className="flex-row flex-wrap gap-1.5 mt-1.5">
            <View className="rounded-full bg-muted px-2.5 py-1 flex-row items-center gap-1">
              {toolName && React.createElement(getToolIcon(toolName), {
                size: 10,
                className: 'text-muted-foreground',
              })}
              <Text className="text-[10px] text-muted-foreground">
                {toolLabel}
              </Text>
            </View>
          </View>
        )}
      </View>
    </Animated.View>
  );
});
