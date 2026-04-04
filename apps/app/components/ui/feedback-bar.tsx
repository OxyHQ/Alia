import React from "react";
import { View, Pressable, type ViewProps } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { ThumbsUp, ThumbsDown, X } from "lucide-react-native";

type FeedbackBarProps = ViewProps & {
  title?: string;
  icon?: React.ReactNode;
  onHelpful?: () => void;
  onNotHelpful?: () => void;
  onClose?: () => void;
};

export function FeedbackBar({
  className,
  title,
  icon,
  onHelpful,
  onNotHelpful,
  onClose,
  ...props
}: FeedbackBarProps) {
  return (
    <View
      className={cn(
        "flex-row items-center rounded-xl border border-border bg-background",
        className
      )}
      {...props}
    >
      <View className="flex-1 flex-row items-center gap-4 py-3 pl-4">
        {icon}
        {title && <Text className="text-sm font-medium">{title}</Text>}
      </View>

      <View className="flex-row items-center gap-0.5 px-3">
        <Pressable
          onPress={onHelpful}
          accessibilityLabel="Helpful"
          className="h-8 w-8 items-center justify-center rounded-md web:hover:bg-accent active:bg-accent"
        >
          <ThumbsUp size={16} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          onPress={onNotHelpful}
          accessibilityLabel="Not helpful"
          className="h-8 w-8 items-center justify-center rounded-md web:hover:bg-accent active:bg-accent"
        >
          <ThumbsDown size={16} className="text-muted-foreground" />
        </Pressable>
      </View>

      <View className="border-l border-border items-center justify-center">
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close"
          className="items-center justify-center rounded-md p-3 web:hover:bg-accent active:bg-accent"
        >
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
}
