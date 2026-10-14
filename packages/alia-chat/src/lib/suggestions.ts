import type { AliaSuggestion } from '../types';

/**
 * Which suggestions a draft gets, shared by the Alia app and the SDK chat so they offer the
 * same rows: the welcome suggestions while the draft is short, and from two characters the
 * search's matches with the typed part located inside each.
 */

/** Up to this many rows. */
export const MAX_ROWS = 6;
/** The draft length at which the search takes over from the welcome list. */
export const SEARCH_FROM = 2;
/** How long typing settles before the search is asked. */
export const SEARCH_DEBOUNCE_MS = 200;

export interface Completion<T extends AliaSuggestion = AliaSuggestion> {
  suggestion: T;
  /** The typed text's range inside `suggestion.text`, or an empty range. */
  matchStart: number;
  matchEnd: number;
}

/** Which rows to show for a draft: welcome while short, matches from two characters. */
export function composerCompletions<T extends AliaSuggestion>(
  draft: string,
  welcome: readonly T[] | undefined,
  matches: readonly T[] | undefined,
): Completion<T>[] {
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
  const rows: Completion<T>[] = [];
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
