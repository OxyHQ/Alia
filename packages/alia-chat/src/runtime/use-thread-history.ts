import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAliaApi } from './api';
import { errorStatus } from './error-utils';
import { aliaQueryKeys } from './query-keys';
import { AGENT_ROUTES } from './routes';
import { type ThreadPage, threadHistory } from './thread/thread-history';

/**
 * Everything said in this thread before the conversation on screen, a page at a time, going back.
 *
 * The screen streams into the most recent conversation of the thread and knows nothing older;
 * the thread's messages route is what crosses the seams into the stretches before it. Pages are
 * pulled as the reader approaches the top, never eagerly — a thread has no end going backwards,
 * and the first page is already everything a reader who does not scroll will see.
 *
 * `nextCursor` is what says whether anything older remains, and it is the server's answer rather
 * than a count: a page that comes back empty after its live messages are dropped is ordinary, and
 * treating that as the end would stop the history dead on any thread whose current conversation
 * is long.
 */

/** How many messages a page carries. The server clamps its own maximum. */
const PAGE_SIZE = 50;

/** A 404 is the answer — the agent does not exist or is not the person's, and asking again does not change it. */
export function retryThreadRead(failureCount: number, error: unknown): boolean {
  return errorStatus(error) !== 404 && failureCount < 2;
}

export function useThreadHistory(
  handle: string | undefined,
  activeConversationId: string | undefined,
) {
  const api = useAliaApi();
  const query = useInfiniteQuery({
    queryKey: aliaQueryKeys.threads.messages(handle ?? ''),
    queryFn: async ({ pageParam }): Promise<ThreadPage> => {
      const { data } = await api.get<ThreadPage>(AGENT_ROUTES.threadMessages(handle ?? ''), {
        params: { limit: PAGE_SIZE, before: pageParam },
      });
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Nothing to page through until the thread has answered which conversation is the live one:
    // without it every message would be history, including the ones already on screen.
    enabled: (handle?.length ?? 0) > 0 && activeConversationId !== undefined,
    retry: retryThreadRead,
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
