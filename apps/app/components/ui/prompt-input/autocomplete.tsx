import React, { useState, useEffect, useRef, useMemo } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import {
  getCompletionsHybrid,
  type PromptCompletion,
} from "@/lib/prompt-completions";
import { usePromptInput } from "./context";
import { useAutocompleteSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";

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
  const { data: cachedSuggestions } = useAutocompleteSuggestions();
  const recordUsage = useRecordSuggestionUsage();

  // Memoize the cached suggestions for stable reference
  const suggestions = useMemo(() => cachedSuggestions || [], [cachedSuggestions]);

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
      setCompletions(getCompletionsHybrid(trimmed, suggestions));
    }, 100);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, enabled, suggestions]);

  if (completions.length === 0) return null;

  return (
    <View className={className}>
      <View className={position === "bottom" ? "pt-0.5" : "pb-0.5"}>
        {completions.map((item) => (
          <Pressable
            key={item.suggestionId || item.text}
            onPress={() => {
              if (item.suggestionId) {
                recordUsage.mutate(item.suggestionId);
              }
              setValue(item.text);
            }}
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
