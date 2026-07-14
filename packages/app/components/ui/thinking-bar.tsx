import React, { useEffect } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@oxyhq/bloom/theme";

type ThinkingBarProps = {
  className?: string;
  text?: string;
  onStop?: () => void;
  stopLabel?: string;
  onPress?: () => void;
};

function ShimmerText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1200 }),
        withTiming(0.5, { duration: 1200 })
      ),
      -1
    );
  }, [opacity]);

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={shimmerStyle}>
      <Text className={cn("font-medium text-foreground", className)}>
        {children}
      </Text>
    </Animated.View>
  );
}

export function ThinkingBar({
  className,
  text = "Thinking",
  onStop,
  stopLabel = "Answer now",
  onPress,
}: ThinkingBarProps) {
  const { colors } = useTheme();
  return (
    <View className={cn("w-full flex-row items-center justify-between", className)}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          className="flex-row items-center gap-1 active:opacity-70"
        >
          <ShimmerText>{text}</ShimmerText>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Pressable>
      ) : (
        <ShimmerText>{text}</ShimmerText>
      )}
      {onStop && (
        <Pressable
          onPress={onStop}
          className="web:hover:opacity-80 active:opacity-70"
        >
          <Text
            className="text-sm text-muted-foreground"
            style={{ borderBottomWidth: 1, borderStyle: "dotted", borderColor: colors.border }}
          >
            {stopLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
