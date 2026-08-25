import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';
import { errorStatus } from '../errors/error-utils';
import { threadHistory, type ThreadPage } from '../thread-history';

/**
 * Everything said in this thread before the conversation on screen, a page at
 * a time, going back.
 *
 * The screen streams into the most recent conversation of the pair and knows
 * nothing older; `GET /agents/thread/:username/messages` is what crosses the
 * seams into the stretches before it. Pages are pulled as the reader
 * approaches the top, never eagerly — a thread has no end going backwards, and
 * the first page is already everything a reader who does not scroll will see.
 *
 * `nextCursor` is what says whether anything older remains, and it is the
 * server's answer rather than a count: a page that comes back empty after its
 * live messages are dropped is ordinary, and treating that as the end would
 * stop the history dead on any thread whose current conversation is long.
 */

/** How many messages a page carries. The server clamps its own maximum. */
const PAGE_SIZE = 50;

export function useThreadHistory(handle: string | undefined, activeConversationId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.agents.threadMessages(handle ?? ''),
    queryFn: async ({ pageParam }): Promise<ThreadPage> => {
      const params: { limit: number; before?: string } = { limit: PAGE_SIZE };
      if (pageParam !== undefined) params.before = pageParam;
      const response = await apiClient.get<ThreadPage>(
        API_ROUTES.agents.threadMessages(handle ?? ''),
        { params },
      );
      return response.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    /**
     * Nothing to page through until the thread has answered which conversation
     * is the live one: without it every message would be history, including the
     * ones already on screen.
     */
    enabled: (handle?.length ?? 0) > 0 && activeConversationId !== undefined,
    /**
     * A 404 is the answer — the agent does not exist, or this person cannot
     * reach it, and the two are deliberately indistinguishable. Asking again
     * three times does not change either.
     */
    retry: (failureCount, error) => errorStatus(error) !== 404 && failureCount < 2,
  });

  const messages = useMemo(
    () => threadHistory(query.data?.pages ?? [], activeConversationId ?? ''),
    [query.data?.pages, activeConversationId],
  );

  return {
    messages,
    /** Whether a page older than the ones held remains to be asked for. */
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
  };
}
