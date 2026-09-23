import {
  useRecordSuggestionUsage,
  useSearchSuggestions,
  useWelcomeSuggestions,
} from '@/lib/hooks/use-suggestions';
import { cn } from '@/lib/utils';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
/**
 * The suggestion list over the composer — and the keyboard that drives it.
 *
 * ## Why it takes props now
 *
 * It used to read the draft out of `PromptInputContext` and register its key
 * handler back into the same object, which is what made it a part of one
 * composer rather than a list that can sit over any of them. Bloom's pill has
 * no context to join; what it has is `onKeyPress`, which fires the field's keys
 * BEFORE its own Enter rule and stops at a `defaultPrevented` event. So the
 * arrows, Enter and Escape reach this list the same way they always did, and
 * the wiring is a callback the composer holds rather than a context both sides
 * have to be inside.
 *
 * `onKeyHandlerChange` is the whole of that wiring: this component hands up a
 * function while it has rows to steer, and `null` when it has none — so the
 * composer knows, without asking, whether there is anything for an arrow key to
 * do. That distinction is load-bearing. A handler that always existed and
 * returned `false` for an empty list would still have had to be CALLED on every
 * keystroke, and Enter would have taken a round trip through a list with
 * nothing in it before reaching the field that was going to send the message.
 */

interface Completion {
  text: string;
  matchStart: number;
  matchEnd: number;
  suggestionId?: string;
  /** Needs user completion (e.g. "edit this image") → fill the input instead of sending. */
  isTemplate?: boolean;
}

export type ComposerAutocompleteProps = {
  enabled?: boolean;
  position?: "top" | "bottom";
  className?: string;
  /** When true (empty conversation), show default welcome suggestions while the query is short. */
  showDefaultSuggestions?: boolean;
  /** The draft, as the composer holds it. */
  value: string;
  /** Fill the composer with a template that still needs finishing. */
  setValue: (value: string) => void;
  /** Send a suggestion's text directly (non-template selections), bypassing the draft. */
  onSuggestionSend?: (text: string) => void;
  /**
   * The key handler while there are rows to steer, or `null`. Called on every
   * change of either, so the composer never holds a handler for a list that is
   * no longer on screen.
   */
  onKeyHandlerChange: (handler: ((key: string) => boolean) | null) => void;
};

export function ComposerAutocomplete({
  enabled = true,
  position = "top",
  className,
  showDefaultSuggestions = false,
  value,
  setValue,
  onSuggestionSend,
  onKeyHandlerChange,
}: ComposerAutocompleteProps) {
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

  // Hand the key handler up while there are rows, and take it back when there
  // are not. The cleanup matters as much as the registration: a list that
  // unmounts while its handler is still held is a composer whose Enter is
  // being offered to a list that is not on screen.
  useEffect(() => {
    onKeyHandlerChange(completions.length > 0 ? handleKey : null);
    return () => onKeyHandlerChange(null);
  }, [completions.length, handleKey, onKeyHandlerChange]);

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
