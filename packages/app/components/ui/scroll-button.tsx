import React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "@/components/ui/icons/chevron-down-icon";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";

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
  const { colors } = useColorScheme();

  if (isAtBottom) return null;

  return (
    <Animated.View entering={FadeInDown.duration(150)} exiting={FadeOutDown.duration(150)}>
      <Button
        variant={variant}
        size={size}
        className={cn("h-10 w-10 rounded-full", className)}
        onPress={onScrollToBottom}
        {...props}
      >
        <ChevronDownIcon size={20} color={colors.foreground} />
      </Button>
    </Animated.View>
  );
}

export { ScrollButton };
