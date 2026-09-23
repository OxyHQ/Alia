import {
  useSearchSuggestions,
  useWelcomeSuggestions,
  type Suggestion,
} from '@/lib/hooks/use-suggestions';
import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';

/**
 * Suggestions over the composer, as Alia had them: on a fresh conversation the
 * welcome suggestions while the draft is short, and from two characters the
 * search's matches with the typed part highlighted. Arrow keys move through
 * them, Enter picks, Escape closes — through the composer's own `onKeyPress`.
 */

/** Up to this many rows, as before. */
const MAX_ROWS = 6;
/** The draft length at which the search takes over from the welcome list. */
const SEARCH_FROM = 2;
/** How long typing settles before the search is asked. */
const SEARCH_DEBOUNCE_MS = 200;

export interface Completion {
  suggestion: Suggestion;
  /** The typed text's range inside `suggestion.text`, or an empty range. */
  matchStart: number;
  matchEnd: number;
}

/** Which rows to show for a draft: welcome while short, matches from two characters. */
export function composerCompletions(
  draft: string,
  welcome: readonly Suggestion[] | undefined,
  matches: readonly Suggestion[] | undefined,
): Completion[] {
  const query = draft.trim();
  if (query.length < SEARCH_FROM) {
    return (welcome ?? []).slice(0, MAX_ROWS).map((suggestion) => ({
      suggestion,
      matchStart: 0,
      matchEnd: 0,
    }));
  }
  const lower = query.toLowerCase();
  const seen = new Set<string>();
  const rows: Completion[] = [];
  for (const suggestion of matches ?? []) {
    if (rows.length >= MAX_ROWS) break;
    const text = suggestion.text.toLowerCase();
    if (seen.has(text)) continue;
    seen.add(text);
    const start = text.indexOf(lower);
    rows.push({
      suggestion,
      matchStart: start === -1 ? 0 : start,
      matchEnd: start === -1 ? 0 : start + query.length,
    });
  }
  return rows;
}

export function useComposerSuggestions({
  draft,
  enabled,
  onPick,
}: {
  draft: string;
  /** Only a fresh conversation offers suggestions. */
  enabled: boolean;
  onPick: (suggestion: Suggestion) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const next = enabled ? draft.trim() : '';
    if (next.length < SEARCH_FROM) {
      setQuery('');
      return;
    }
    const timer = setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, enabled]);

  // A new draft reopens the list and clears the keyboard selection.
  useEffect(() => {
    setDismissed(false);
    setSelected(-1);
  }, [draft]);

  const { data: welcome } = useWelcomeSuggestions();
  const { data: matches } = useSearchSuggestions(query);

  const completions = useMemo(
    () => (enabled && !dismissed ? composerCompletions(draft, welcome, matches) : []),
    [enabled, dismissed, draft, welcome, matches],
  );

  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (completions.length === 0) return;
      const key = event.nativeEvent.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const step = key === 'ArrowDown' ? 1 : -1;
        setSelected((current) => (current + step + completions.length) % completions.length);
      } else if (key === 'Enter' && selected >= 0) {
        event.preventDefault();
        onPick(completions[selected].suggestion);
      } else if (key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
      }
    },
    [completions, selected, onPick],
  );

  return { completions, selected, onKeyPress };
}

export function ComposerSuggestions({
  completions,
  selected,
  onPick,
}: {
  completions: readonly Completion[];
  selected: number;
  onPick: (suggestion: Suggestion) => void;
}) {
  if (completions.length === 0) return null;
  return (
    <View accessibilityRole="list" className="w-full max-w-[768px] self-center">
      {completions.map(({ suggestion, matchStart, matchEnd }, index) => {
        const { text } = suggestion;
        return (
          <Item
            key={suggestion.suggestionId}
            density="compact"
            highlighted={index === selected}
            accessibilityRole="button"
            accessibilityLabel={text}
            onPress={() => onPick(suggestion)}
            title={
              <Text numberOfLines={1}>
                {text.slice(0, matchStart)}
                <Text className="font-medium text-primary">{text.slice(matchStart, matchEnd)}</Text>
                {text.slice(matchEnd)}
              </Text>
            }
          />
        );
      })}
    </View>
  );
}
