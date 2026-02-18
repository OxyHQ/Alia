import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
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
  const { value, setValue, setHandleCompletionKey } = usePromptInput();
  const [completions, setCompletions] = useState<PromptCompletion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const selectedIndexRef = useRef(-1);
  const completionsRef = useRef<PromptCompletion[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data: cachedSuggestions } = useAutocompleteSuggestions();
  const recordUsage = useRecordSuggestionUsage();

  // Memoize the cached suggestions for stable reference
  const suggestions = useMemo(() => cachedSuggestions || [], [cachedSuggestions]);

  // Keep completions ref in sync
  useEffect(() => {
    completionsRef.current = completions;
  }, [completions]);

  useEffect(() => {
    // Reset selection when user types
    selectedIndexRef.current = -1;
    setSelectedIndex(-1);

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

  // Arrow key handler — stable callback using refs
  const handleKey = useCallback((key: string): boolean => {
    const items = completionsRef.current;
    if (items.length === 0) return false;

    if (key === "ArrowDown") {
      const next = selectedIndexRef.current < items.length - 1
        ? selectedIndexRef.current + 1
        : 0;
      selectedIndexRef.current = next;
      setSelectedIndex(next);
      return true;
    }

    if (key === "ArrowUp") {
      const next = selectedIndexRef.current > 0
        ? selectedIndexRef.current - 1
        : items.length - 1;
      selectedIndexRef.current = next;
      setSelectedIndex(next);
      return true;
    }

    if (key === "Enter") {
      if (selectedIndexRef.current < 0) return false;
      const item = items[selectedIndexRef.current];
      if (item.suggestionId) recordUsage.mutate(item.suggestionId);
      setValue(item.text);
      return true;
    }

    if (key === "Escape") {
      if (selectedIndexRef.current < 0) return false;
      selectedIndexRef.current = -1;
      setSelectedIndex(-1);
      return true;
    }

    return false;
  }, [setValue, recordUsage]);

  // Register/unregister the key handler based on completions
  useEffect(() => {
    if (completions.length > 0) {
      setHandleCompletionKey(() => handleKey);
    } else {
      setHandleCompletionKey(null);
    }
    return () => setHandleCompletionKey(null);
  }, [completions.length > 0, handleKey, setHandleCompletionKey]);

  if (completions.length === 0) return null;

  return (
    <View className={className}>
      <View className={position === "bottom" ? "pt-0.5" : "pb-0.5"}>
        {completions.map((item, index) => (
          <Pressable
            key={item.suggestionId || item.text}
            onPress={() => {
              if (item.suggestionId) {
                recordUsage.mutate(item.suggestionId);
              }
              setValue(item.text);
            }}
            className={cn(
              "px-3 py-1.5 rounded-lg active:bg-muted/50",
              index === selectedIndex && "bg-muted"
            )}
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
