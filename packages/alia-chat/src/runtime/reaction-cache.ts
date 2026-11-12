import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { applyMessageReaction, type MessageReactionSnapshot } from './message-reactions';
import { aliaQueryKeys } from './query-keys';
import type { ThreadPage } from './thread/thread-history';
import type { Conversation } from './types';

/** Keep already fetched live messages and historical pages consistent with a saved reaction. */
export function updateReactionCaches(client: QueryClient, update: MessageReactionSnapshot): void {
  client.setQueryData<Conversation>(
    aliaQueryKeys.conversations.detail(update.conversationId),
    (previous) =>
      previous
        ? { ...previous, messages: applyMessageReaction(previous.messages ?? [], update) }
        : previous,
  );
  client.setQueriesData<InfiniteData<ThreadPage>>(
    {
      predicate: ({ queryKey }) =>
        queryKey[0] === 'agent-thread-messages' || queryKey[0] === 'agent-thread-window',
    },
    (previous) =>
      previous
        ? {
            ...previous,
            pages: previous.pages.map((page) => ({
              ...page,
              messages: page.messages.map((message) =>
                message.conversationId === update.conversationId &&
                (message.id ?? message.cursor) === update.messageId &&
                (update.revision === undefined ||
                  (message.reactionRevision ?? 0) <= update.revision)
                  ? {
                      ...message,
                      reactions: update.reactions,
                      ...(update.reactionEntries === undefined
                        ? {}
                        : { reactionEntries: update.reactionEntries }),
                      ...(update.revision === undefined
                        ? {}
                        : { reactionRevision: update.revision }),
                    }
                  : message,
              ),
            })),
          }
        : previous,
  );
}
