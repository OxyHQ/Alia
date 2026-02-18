import React, { useEffect } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";

export type ScrollButtonProps = Omit<ButtonProps, "children"> & {
  isAtBottom: boolean;
  onScrollToBottom: () => void;
};

function ScrollButton({
  className,
  variant = "outline",
  size = "icon",
  isAtBottom,
  onScrollToBottom,
  ...props
}: ScrollButtonProps) {
  const opacity = useSharedValue(isAtBottom ? 0 : 1);
  const translateY = useSharedValue(isAtBottom ? 16 : 0);

  useEffect(() => {
    opacity.value = withTiming(isAtBottom ? 0 : 1, { duration: 150 });
    translateY.value = withTiming(isAtBottom ? 16 : 0, { duration: 150 });
  }, [isAtBottom, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (isAtBottom) return null;

  return (
    <Animated.View style={animatedStyle}>
      <Button
        variant={variant}
        size={size}
        className={cn("h-10 w-10 rounded-full", className)}
        onPress={onScrollToBottom}
        {...props}
      >
        <ChevronDown size={20} className="text-foreground" />
      </Button>
    </Animated.View>
  );
}

export { ScrollButton };
