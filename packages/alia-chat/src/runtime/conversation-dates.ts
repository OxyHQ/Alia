import type { ConversationsInfiniteData } from './types';

/** A Date, whether it was just fetched or came back from the persisted cache, which keeps JSON. */
const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/**
 * The list as readers see it: its dates are Dates.
 *
 * The list is persisted per account so the sidebar paints from the last session (`ALIA_ACCOUNT_QUERIES`),
 * and persistence is JSON: a hydrated page holds `updatedAt` as an ISO string, not a Date. Reviving
 * them here, where every reader of the list reads it, keeps `Conversation` the type it says it is.
 */
export function reviveConversationDates(
  data: ConversationsInfiniteData,
): ConversationsInfiniteData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      conversations: page.conversations.map((conversation) =>
        conversation.updatedAt instanceof Date && conversation.createdAt instanceof Date
          ? conversation
          : {
              ...conversation,
              createdAt: asDate(conversation.createdAt),
              updatedAt: asDate(conversation.updatedAt),
            },
      ),
    })),
  };
}
