import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';
import { errorStatus } from '../errors/error-utils';
import { threadHistory, type ThreadMessage, type ThreadPage } from '../thread-history';

/**
 * Finding something said earlier in a thread, and getting back to it.
 *
 * Two halves, and the second is why the first is worth anything: a hit tells
 * you the message exists, and its CURSOR is what opens the stretch of thread
 * around it — however many conversations back it lives. Without that, a result
 * list is a wall you can read and not reach.
 */

/** One hit. `messageId` is the client's id, which a message the server wrote has none of. */
export interface ThreadSearchHit {
  messageId: string | null;
  conversationId: string;
  role: string;
  snippet: string;
  createdAt: string;
  /** Where this message is, in the only form that can be asked for. */
  cursor: string;
}

/** How many hits to ask for. The server clamps its own maximum. */
const HIT_LIMIT = 30;

export function useThreadSearch(handle: string | undefined, query: string) {
  const trimmed = query.trim();

  return useQuery({
    queryKey: queryKeys.agents.threadSearch(handle ?? '', trimmed),
    queryFn: async (): Promise<ThreadSearchHit[]> => {
      const response = await apiClient.get<{ hits: ThreadSearchHit[] }>(
        API_ROUTES.agents.threadSearch(handle ?? ''),
        { params: { q: trimmed, limit: HIT_LIMIT } },
      );
      return response.data.hits;
    },
    /**
     * An empty query is not a search, and asking for one would return the
     * thread's most recent everything under the guise of a result.
     */
    enabled: (handle?.length ?? 0) > 0 && trimmed.length > 0,
    /**
     * What was said cannot change, so a query already asked is answered from
     * the cache — which is what makes deleting a character instant rather than
     * a second round trip.
     */
    staleTime: 1000 * 60 * 5,
    retry: (failureCount, error) => errorStatus(error) !== 404 && failureCount < 2,
  });
}

/** How many messages a window carries, half of them before the hit. */
const WINDOW_SIZE = 40;

/**
 * The stretch of thread around one message, opened from a search hit.
 *
 * `at=` rather than `before=`: `before` is exclusive, so the one message the
 * window exists to reveal would be the one missing from it.
 *
 * Reading further back from here is the same paging as anywhere else — the
 * window's own oldest cursor continues it — so this is an infinite query too,
 * and only its first page is addressed differently. There is no paging
 * FORWARD: the way back to the present is leaving the window, not walking to
 * it.
 */
export function useThreadWindow(handle: string | undefined, cursor: string | null) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.agents.threadWindow(handle ?? '', cursor ?? ''),
    queryFn: async ({ pageParam }): Promise<ThreadPage> => {
      const response = await apiClient.get<ThreadPage>(
        API_ROUTES.agents.threadMessages(handle ?? ''),
        {
          params:
            pageParam === undefined
              ? { limit: WINDOW_SIZE, at: cursor }
              : { limit: WINDOW_SIZE, before: pageParam },
        },
      );
      return response.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: (handle?.length ?? 0) > 0 && cursor !== null,
    retry: (failureCount, error) => errorStatus(error) !== 404 && failureCount < 2,
  });

  /**
   * Nothing is dropped here, unlike the tail: a window is a view of the PAST,
   * and the live conversation is not on screen underneath it to be duplicated.
   * The empty string is a conversation id no message has.
   */
  const messages: ThreadMessage[] = useMemo(
    () => threadHistory(query.data?.pages ?? [], ''),
    [query.data?.pages],
  );

  return {
    messages,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
    isLoading: query.isPending && cursor !== null,
  };
}
