import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { View, Pressable } from "react-native";
import { Text } from "../text";
import { cn } from "../../../lib/utils";
import { usePromptInput, type Completion } from "./context";

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
  const { value, setValue, setHandleCompletionKey, useSuggestions, onSuggestionUsed } = usePromptInput();
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const selectedIndexRef = useRef(-1);
  const completionsRef = useRef<Completion[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // If no useSuggestions hook is injected, autocomplete is disabled
  const suggestionsResult = useSuggestions?.(debouncedQuery);
  const apiResults = suggestionsResult?.data;

  // Debounce the search query (200ms)
  useEffect(() => {
    if (!enabled || !useSuggestions) {
      setDebouncedQuery('');
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2) {
      setDebouncedQuery('');
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(trimmed), 200);
    return () => clearTimeout(timer);
  }, [value, enabled, useSuggestions]);

  // Map API results to completions with match highlighting
  const completions = useMemo<Completion[]>(() => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2 || !apiResults?.length) return [];

    const lower = trimmed.toLowerCase();
    const results: Completion[] = [];
    const seen = new Set<string>();

    for (const s of apiResults) {
      if (results.length >= 6) break;
      const textLower = s.text.toLowerCase();
      if (seen.has(textLower)) continue;
      seen.add(textLower);

      const idx = textLower.indexOf(lower);
      results.push({
        text: s.text,
        matchStart: idx !== -1 ? idx : 0,
        matchEnd: idx !== -1 ? idx + trimmed.length : 0,
        suggestionId: s.suggestionId,
      });
    }

    return results;
  }, [apiResults, value]);

  // Keep refs in sync
  useEffect(() => {
    completionsRef.current = completions;
  }, [completions]);

  // Reset selection when completions change
  useEffect(() => {
    selectedIndexRef.current = -1;
    setSelectedIndex(-1);
  }, [completions]);

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
      if (item.suggestionId) onSuggestionUsed?.(item.suggestionId);
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
  }, [setValue, onSuggestionUsed]);

  // Register/unregister the key handler based on completions
  useEffect(() => {
    if (completions.length > 0) {
      setHandleCompletionKey(() => handleKey);
    } else {
      setHandleCompletionKey(null);
    }
    return () => setHandleCompletionKey(null);
  }, [completions.length, handleKey, setHandleCompletionKey]);

  // If no suggestions hook or no completions, render nothing
  if (!useSuggestions || completions.length === 0) return null;

  return (
    <View className={className}>
      <View className={position === "bottom" ? "pt-0.5" : "pb-0.5"}>
        {completions.map((item, index) => (
          <Pressable
            key={item.suggestionId || item.text}
            onPress={() => {
              if (item.suggestionId) {
                onSuggestionUsed?.(item.suggestionId);
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
