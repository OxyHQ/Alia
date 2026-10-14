import {
  useSearchSuggestions,
  useWelcomeSuggestions,
  type Suggestion,
} from '@/features/chat/runtime/use-suggestions';
import {
  useComposerSuggestions as useSdkComposerSuggestions,
  useSuggestionQuery,
} from '@alia.onl/sdk';
import { useMemo } from 'react';

/**
 * Suggestions over the composer, with the app's own data. What they look like, which rows a
 * draft gets and how the keyboard moves through them is the SDK chat's (`ComposerSuggestions`,
 * `useComposerSuggestions`); this only supplies the welcome list and the search's matches from
 * the API, through react-query.
 */

/** The SDK keys a row by `id`; the API calls it `suggestionId`. */
type AppSuggestion = Suggestion & { id: string };
const withId = (suggestions: readonly Suggestion[] | undefined): AppSuggestion[] | undefined =>
  suggestions?.map((suggestion) => ({ ...suggestion, id: suggestion.suggestionId }));

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
  const query = useSuggestionQuery(draft, enabled);
  const { data: welcome } = useWelcomeSuggestions();
  const { data: matches } = useSearchSuggestions(query);
  const welcomeRows = useMemo(() => withId(welcome), [welcome]);
  const matchRows = useMemo(() => withId(matches), [matches]);
  return useSdkComposerSuggestions({
    draft,
    enabled,
    welcome: welcomeRows,
    matches: matchRows,
    onPick,
  });
}
