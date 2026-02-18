import React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react-native";
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
        <ChevronDown size={20} className="text-foreground" />
      </Button>
    </Animated.View>
  );
}

export { ScrollButton };
