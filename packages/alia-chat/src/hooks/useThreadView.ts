import { useCallback, useMemo, useState } from 'react';
import type { ThreadHistory, ThreadSearchHit } from '../runtime/thread/thread-history';
import { useThreadHistory } from '../runtime/use-thread-history';
import { useThreadWindow } from '../runtime/use-thread-search';

/**
 * What the thread looks at: the present, or a moment in its past.
 *
 * An agent's thread has two states and they are not variations of one. At the present, the
 * history runs into the conversation being streamed into. At a moment — a hit of the thread's
 * search — the screen shows the stretch around one old message and there is nothing live beneath
 * it. The way back is leaving, not scrolling: the endpoint pages BACKWARDS only, so walking
 * forward from a jump would be a road that ends.
 *
 * `threadHandle` is the agent's handle; without it the chat is one conversation with nothing
 * behind it and there is nothing to page into, search or jump to.
 */
export function useThreadView(
  threadHandle: string | undefined,
  conversationId: string | undefined,
) {
  const present = useThreadHistory(threadHandle, conversationId);
  const [searchOpen, setSearchOpen] = useState(false);
  /** The message the reader jumped to, by cursor, or `null` for the present. */
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);
  const past = useThreadWindow(threadHandle, jumpedTo);
  const jumped = jumpedTo !== null;

  // Ask for the page above, unless one is already coming. Bloom fires `onStartReached` once per
  // approach and re-arms when the reader leaves the zone, so the guards left are about the DATA.
  const source = jumped
    ? { ...past, loading: past.isLoadingMore || past.isLoading }
    : { ...present, loading: present.isLoadingMore };
  const { messages, hasMore, loading, loadMore: fetchMore } = source;
  const loadMore = useCallback(() => {
    if (!loading) void fetchMore();
  }, [loading, fetchMore]);

  const history = useMemo<ThreadHistory | undefined>(
    () =>
      threadHandle === undefined
        ? undefined
        : { messages, loading, ...(hasMore ? { loadMore } : {}) },
    [threadHandle, messages, loading, hasMore, loadMore],
  );

  /**
   * Open the thread around a hit, and close the search over it. The cursor rather than the
   * message id: an id addresses a message, and only a cursor addresses a POSITION, which is what
   * a window is asked for.
   */
  const jump = useCallback((hit: ThreadSearchHit) => {
    setJumpedTo(hit.cursor);
    setSearchOpen(false);
  }, []);

  return {
    history,
    /** The cursor jumped to, or `null` at the present. */
    focusCursor: jumpedTo,
    jumped,
    jump,
    backToLatest: useCallback(() => setJumpedTo(null), []),
    searchOpen,
    openSearch: useCallback(() => setSearchOpen(true), []),
    closeSearch: useCallback(() => setSearchOpen(false), []),
  };
}
