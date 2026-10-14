import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native';
import {
  type Completion,
  SEARCH_DEBOUNCE_MS,
  SEARCH_FROM,
  composerCompletions,
} from '../lib/suggestions';
import type { AliaSuggestion } from '../types';

/**
 * The draft, once typing has settled, for the host to search with; empty while the draft is
 * too short to search or suggestions are off. The data stays the host's: the Alia app asks its
 * API through react-query, a host of the SDK chat asks whatever it has.
 */
export function useSuggestionQuery(draft: string, enabled: boolean): string {
  const [query, setQuery] = useState('');
  useEffect(() => {
    const next = enabled ? draft.trim() : '';
    if (next.length < SEARCH_FROM) {
      setQuery('');
      return;
    }
    const timer = setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, enabled]);
  return query;
}

/**
 * The suggestions over a composer: the rows for the draft, which one the keyboard is on, and
 * the composer's own `onKeyPress` (arrows move, Enter picks the selected row, Escape closes).
 * Enter is left to the composer while no row is selected.
 */
export function useComposerSuggestions<T extends AliaSuggestion>({
  draft,
  enabled,
  welcome,
  matches,
  onPick,
}: {
  draft: string;
  /** Only a fresh conversation offers suggestions. */
  enabled: boolean;
  welcome: readonly T[] | undefined;
  matches: readonly T[] | undefined;
  onPick: (suggestion: T) => void;
}) {
  const [selected, setSelected] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  // A new draft reopens the list and clears the keyboard selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is the trigger
  useEffect(() => {
    setDismissed(false);
    setSelected(-1);
  }, [draft]);

  const completions: Completion<T>[] = useMemo(
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
        onPick(completions[selected]!.suggestion);
      } else if (key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
      }
    },
    [completions, selected, onPick],
  );

  return { completions, selected, onKeyPress };
}
