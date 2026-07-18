import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { usePromptInput } from "./context";
import { useSearchSuggestions, useWelcomeSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";

interface Completion {
  text: string;
  matchStart: number;
  matchEnd: number;
  suggestionId?: string;
  /** Needs user completion (e.g. "edit this image") → fill the input instead of sending. */
  isTemplate?: boolean;
}

export type PromptInputAutocompleteProps = {
  enabled?: boolean;
  position?: "top" | "bottom";
  className?: string;
  /** When true (empty conversation), show default welcome suggestions while the query is short. */
  showDefaultSuggestions?: boolean;
};

export function PromptInputAutocomplete({
  enabled = true,
  position = "top",
  className,
  showDefaultSuggestions = false,
}: PromptInputAutocompleteProps) {
  const { value, setValue, setHandleCompletionKey, onSuggestionSend } = usePromptInput();
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const selectedIndexRef = useRef(-1);
  const completionsRef = useRef<Completion[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const { mutate: recordUsage } = useRecordSuggestionUsage();

  // Debounce the search query (200ms). Only search on a fresh/empty conversation —
  // never hit /suggestions/search once the conversation is active.
  useEffect(() => {
    if (!enabled || !showDefaultSuggestions) {
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
  }, [value, enabled, showDefaultSuggestions]);

  // API search results (fires when debouncedQuery changes)
  const { data: apiResults } = useSearchSuggestions(debouncedQuery);
  // Default welcome suggestions (shared cache; prefetched by the app layout)
  const { data: welcomeResults } = useWelcomeSuggestions();

  // Suggestions of any kind only belong on a fresh/empty conversation. Once the
  // conversation is active neither live search nor welcome chips should appear.
  // Dual mode: query >= 2 chars → search results with match highlighting; empty
  // conversation + short query → default welcome suggestions; otherwise nothing.
  const completions = useMemo<Completion[]>(() => {
    if (!showDefaultSuggestions) return [];
    const trimmed = value.trim();

    if (trimmed.length >= 2) {
      if (!apiResults?.length) return [];
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
          isTemplate: s.isTemplate || (s.templateVariables?.length ?? 0) > 0,
        });
      }
      return results;
    }

    const results: Completion[] = [];
    const seen = new Set<string>();
    for (const s of welcomeResults ?? []) {
      if (results.length >= 6) break;
      const textLower = s.text.toLowerCase();
      if (seen.has(textLower)) continue;
      seen.add(textLower);
      results.push({
        text: s.text,
        matchStart: 0,
        matchEnd: 0,
        suggestionId: s.suggestionId,
        isTemplate: s.isTemplate || (s.templateVariables?.length ?? 0) > 0,
      });
    }
    return results;
  }, [apiResults, welcomeResults, value, showDefaultSuggestions]);

  // Keep refs in sync
  useEffect(() => {
    completionsRef.current = completions;
  }, [completions]);

  // Reset selection when completions change
  useEffect(() => {
    selectedIndexRef.current = -1;
    setSelectedIndex(-1);
  }, [completions]);

  // Select a completion: templates (need user completion) fill the input; plain
  // suggestions send directly via the chat's send path. Usage recorded either way.
  const selectCompletion = useCallback((item: Completion) => {
    if (item.suggestionId) recordUsage(item.suggestionId);
    if (item.isTemplate || !onSuggestionSend) {
      setValue(item.text);
    } else {
      onSuggestionSend(item.text);
    }
  }, [recordUsage, setValue, onSuggestionSend]);

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
      selectCompletion(items[selectedIndexRef.current]);
      return true;
    }

    if (key === "Escape") {
      if (selectedIndexRef.current < 0) return false;
      selectedIndexRef.current = -1;
      setSelectedIndex(-1);
      return true;
    }

    return false;
  }, [selectCompletion]);

  // Register/unregister the key handler based on completions
  useEffect(() => {
    if (completions.length > 0) {
      setHandleCompletionKey(() => handleKey);
    } else {
      setHandleCompletionKey(null);
    }
    return () => setHandleCompletionKey(null);
  }, [completions.length, handleKey, setHandleCompletionKey]);

  if (completions.length === 0) return null;

  return (
    <View className={className}>
      <View className={position === "bottom" ? "pt-0.5" : "pb-0.5"}>
        {completions.map((item, index) => (
          <Pressable
            key={item.suggestionId || item.text}
            onPress={() => selectCompletion(item)}
            className={cn(
              "px-3 py-1.5 rounded-lg active:bg-muted/50 web:hover:bg-muted/40",
              index === selectedIndex && "bg-muted/40"
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
