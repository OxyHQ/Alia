import React, { useState, useEffect, useRef } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import {
  getCompletions,
  type PromptCompletion,
} from "@/lib/prompt-completions";
import { usePromptInput } from "./context";

export type PromptInputAutocompleteProps = {
  enabled?: boolean;
  position?: "top" | "bottom";
  className?: string;
};

export function PromptInputAutocomplete({
  enabled = true,
  position = "top",
  className,
}: PromptInputAutocompleteProps) {
  const { value, setValue } = usePromptInput();
  const [completions, setCompletions] = useState<PromptCompletion[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCompletions([]);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2) {
      setCompletions([]);
      return;
    }

    timerRef.current = setTimeout(() => {
      setCompletions(getCompletions(trimmed));
    }, 100);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, enabled]);

  if (completions.length === 0) return null;

  return (
    <View className={className}>
      <View className={position === "bottom" ? "pt-0.5" : "pb-0.5"}>
        {completions.map((item) => (
          <Pressable
            key={item.text}
            onPress={() => setValue(item.text)}
            className="px-3 py-1.5 rounded-lg active:bg-muted/50"
          >
            <Text className="text-sm leading-5" numberOfLines={1}>
              <Text className="text-foreground">
                {item.text.slice(0, item.matchStart)}
              </Text>
              <Text className="text-primary font-medium">
                {item.text.slice(item.matchStart, item.matchEnd)}
              </Text>
              <Text className="text-foreground">
                {item.text.slice(item.matchEnd)}
              </Text>
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
