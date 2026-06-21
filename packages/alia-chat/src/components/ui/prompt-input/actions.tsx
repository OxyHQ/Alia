import React from "react";
import { View } from "react-native";
import { cn } from "../../../lib/utils";
import { usePromptInput } from "./context";

export type PromptInputActionsProps = React.ComponentProps<typeof View>;

export function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  const { isFullscreen } = usePromptInput();

  return (
    <View
      className={cn(
        "flex-row items-center gap-2",
        isFullscreen &&
          "absolute bottom-4 left-4 right-4 max-w-2xl mx-auto rounded-full border border-border bg-background px-4 py-3",
        className
      )}
      {...props}
    >
      {children}
    </View>
  );
}
