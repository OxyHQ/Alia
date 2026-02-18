import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import {
  getCompletions,
  type PromptCompletion,
} from "@/lib/prompt-completions";
import { usePromptInput } from "./context";
import { useSearchSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";

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
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const selectedIndexRef = useRef(-1);
  const completionsRef = useRef<PromptCompletion[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const recordUsage = useRecordSuggestionUsage();

  // Debounce the search query (200ms)
  useEffect(() => {
    if (!enabled) {
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
  }, [value, enabled]);

  // API search results (fires when debouncedQuery changes)
  const { data: apiResults } = useSearchSuggestions(debouncedQuery);

  // Instant local results (no delay)
  const localResults = useMemo<PromptCompletion[]>(() => {
    if (!enabled) return [];
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2) return [];
    return getCompletions(trimmed, 4);
  }, [value, enabled]);

  // Merge: API results first, fill from local, dedupe
  const completions = useMemo<PromptCompletion[]>(() => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2) return [];

    if (!apiResults?.length) return localResults;

    const results: PromptCompletion[] = [];
    const seen = new Set<string>();
    const lower = trimmed.toLowerCase();

    // API results first
    for (const s of apiResults) {
      if (results.length >= 6) break;
      const idx = s.text.toLowerCase().indexOf(lower);
      const matchStart = idx !== -1 ? idx : 0;
      const matchEnd = idx !== -1 ? idx + trimmed.length : 0;
      const textLower = s.text.toLowerCase();
      if (!seen.has(textLower)) {
        seen.add(textLower);
        results.push({
          text: s.text,
          matchStart,
          matchEnd,
          suggestionId: s.suggestionId,
          isTemplate: s.isTemplate,
          templateVariables: s.templateVariables,
        });
      }
    }

    // Fill from local
    for (const r of localResults) {
      if (results.length >= 6) break;
      if (!seen.has(r.text.toLowerCase())) {
        seen.add(r.text.toLowerCase());
        results.push(r);
      }
    }

    return results;
  }, [apiResults, localResults, value]);

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
