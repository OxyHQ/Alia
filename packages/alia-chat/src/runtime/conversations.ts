import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useMemo } from 'react';
import { useLabels } from '../lib/labels';
import { type AliaApi, useAliaApi } from './api';
import { type OfflineConversationStore, useAliaRuntime } from './config';
import { errorMessage as getErrorMessage, errorStatus } from './error-utils';
import { normalizeConversationMessages } from './message-history';
import { aliaQueryKeys } from './query-keys';
import { createRandomUuid } from './random-uuid';
import type { Conversation, ConversationsInfiniteData, ConversationsPage, Message } from './types';

/** Conversation as returned by the API (timestamps are ISO strings, not Dates). */
type ApiConversation = Omit<Conversation, 'createdAt' | 'updatedAt' | 'messages'> & {
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
};

const PAGE_SIZE = 20;
const FIVE_MINUTES = 1000 * 60 * 5;

/** The routes the conversation runtime calls. */
export const CONVERSATION_ROUTES = {
  list: '/conversations',
  save: '/conversations',
  create: '/conversations/new',
  get: (id: string) => `/conversations/${id}`,
  remove: (id: string) => `/conversations/${id}`,
  /**
   * Empty a thread without removing it: every message goes, the row and its
   * title stay. A sub-resource DELETE rather than a `/clear` verb, because
   * what is being deleted is the message collection and nothing else.
   */
  clearMessages: (id: string) => `/conversations/${id}/messages`,
} as const;

/** A stable signal for a URL whose server-side conversation no longer exists. */
export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super('Conversation not found');
    this.name = 'ConversationNotFoundError';
  }
}

// Message content is either a plain string or a parts array; previews (titles,
// lastMessage) need the flattened text either way.
function messageText(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

/**
 * The offline copy of the conversations: what a session whose token failed
 * (a 401) reads and writes instead of the server. Without a store configured
 * it holds nothing, and the 401 is the caller's to handle.
 */
class OfflineConversations {
  constructor(private readonly store: OfflineConversationStore | null) {}

  get available(): boolean {
    return this.store !== null;
  }

  async read(): Promise<Conversation[]> {
    const stored = await this.store?.getItem();
    if (!stored) return [];
    return (JSON.parse(stored) as Conversation[]).map((conv) => ({
      ...conv,
      createdAt: new Date(conv.createdAt),
      updatedAt: new Date(conv.updatedAt),
    }));
  }

  async write(conversations: Conversation[]): Promise<void> {
    await this.store?.setItem(JSON.stringify(conversations));
  }

  async remove(id: string): Promise<void> {
    if (!this.store) return;
    const stored = await this.store.getItem();
    if (!stored) return;
    try {
      const conversations: Conversation[] = JSON.parse(stored);
      const remaining = conversations.filter((conversation) => conversation.id !== id);
      if (remaining.length !== conversations.length) {
        await this.store.setItem(JSON.stringify(remaining));
      }
    } catch {
      // A malformed offline cache cannot make a valid server response invalid.
    }
  }
}

/** What the conversation functions need: the API and the offline copy. */
export interface ConversationsClient {
  api: AliaApi;
  offline: OfflineConversations;
  /** Read at call time: the title of a chat created while signed out. */
  newChatTitle: string;
}

/** The runtime's conversation client for the nearest provider. */
export function useConversationsClient(): ConversationsClient {
  const api = useAliaApi();
  const { offline } = useAliaRuntime();
  const { newChat } = useLabels();
  return useMemo(
    () => ({ api, offline: new OfflineConversations(offline), newChatTitle: newChat }),
    [api, offline, newChat],
  );
}

async function fetchConversationsPage(
  client: ConversationsClient,
  pageParam: string | undefined,
): Promise<ConversationsPage> {
  try {
    const { data } = await client.api.get<{
      conversations: ApiConversation[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(CONVERSATION_ROUTES.list, {
      params: { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
    });
    return {
      conversations: data.conversations.map((conv) => ({
        ...conv,
        createdAt: new Date(conv.createdAt),
        updatedAt: new Date(conv.updatedAt),
        messages: [], // Don't include messages in list view
      })),
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
    };
  } catch (error: unknown) {
    // If unauthorized, fall back to the offline copy
    if (errorStatus(error) === 401) {
      const conversations = (await client.offline.read()).map((c) => ({
        ...c,
        messages: [] as Message[],
      }));
      const offset = pageParam ? Number.parseInt(pageParam, 10) : 0;
      const page = conversations.slice(offset, offset + PAGE_SIZE);
      return {
        conversations: page,
        nextCursor: offset + PAGE_SIZE < conversations.length ? String(offset + PAGE_SIZE) : null,
        hasMore: offset + PAGE_SIZE < conversations.length,
      };
    }
    throw error;
  }
}

/** The person's conversations, newest first, a page at a time. The sidebar and the sheet read this. */
export function useConversations() {
  const { isAuthenticated } = useOxy();
  const client = useConversationsClient();

  return useInfiniteQuery({
    queryKey: aliaQueryKeys.conversations.all,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchConversationsPage(client, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    staleTime: FIVE_MINUTES,
    retry: 2,
    enabled: isAuthenticated,
  });
}

async function fetchConversation(client: ConversationsClient, id: string): Promise<Conversation> {
  try {
    const { data } = await client.api.get<ApiConversation>(CONVERSATION_ROUTES.get(id));
    return {
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      messages: normalizeConversationMessages(data.messages || []),
    };
  } catch (error: unknown) {
    const status = errorStatus(error);
    // A server-side 404 is authoritative for an authenticated request. Keeping
    // an older offline copy here resurrects a deleted conversation and makes
    // every later read and write hit the same missing id again.
    if (status === 404) {
      await client.offline.remove(id);
      throw new ConversationNotFoundError(id);
    }

    // An unavailable authenticated session can still read its offline copy.
    if (status === 401) {
      const conversation = (await client.offline.read()).find((c) => c.id === id);
      if (conversation) {
        return {
          ...conversation,
          messages: normalizeConversationMessages(conversation.messages || []),
        };
      }
    }
    throw error;
  }
}

/** One conversation with its messages. */
export function useConversation(id: string) {
  const { isAuthenticated } = useOxy();
  const client = useConversationsClient();

  return useQuery({
    queryKey: aliaQueryKeys.conversations.detail(id),
    queryFn: () => fetchConversation(client, id),
    enabled: isAuthenticated && !!id,
    staleTime: FIVE_MINUTES,
    // A missing conversation is deterministic. Retrying only repeats the same
    // 404 and makes one stale local link look like an API outage in the console.
    retry: false,
  });
}

/** Prefetch a conversation's detail (call from the sidebar on press-in / hover). */
export function usePrefetchConversation(): (id: string) => void {
  const queryClient = useQueryClient();
  const client = useConversationsClient();
  return useCallback((id) => prefetchConversation(queryClient, client, id), [queryClient, client]);
}

export function prefetchConversation(
  queryClient: QueryClient,
  client: ConversationsClient,
  id: string,
): void {
  void queryClient.prefetchQuery({
    queryKey: aliaQueryKeys.conversations.detail(id),
    queryFn: () => fetchConversation(client, id),
    staleTime: FIVE_MINUTES,
  });
}

/** Put a conversation's row at the top of the first page (or make the first page). */
function upsertOnTop(
  old: ConversationsInfiniteData | undefined,
  row: Conversation,
  moveExisting: boolean,
): ConversationsInfiniteData {
  if (!old?.pages) {
    return {
      pages: [{ conversations: [row], nextCursor: null, hasMore: false }],
      pageParams: [undefined],
    };
  }
  const pages = [...old.pages];
  if (moveExisting) {
    // Remove the conversation from its current position (if it is in any page)
    for (let i = 0; i < pages.length; i++) {
      const existingIndex = pages[i].conversations.findIndex((c) => c.id === row.id);
      if (existingIndex >= 0) {
        pages[i] = {
          ...pages[i],
          conversations: [
            ...pages[i].conversations.slice(0, existingIndex),
            ...pages[i].conversations.slice(existingIndex + 1),
          ],
        };
        break;
      }
    }
  } else if (pages[0]?.conversations.some((c) => c.id === row.id)) {
    return { ...old, pages };
  }
  // Always add to top of first page (most recently updated first)
  if (pages[0]) {
    pages[0] = { ...pages[0], conversations: [row, ...pages[0].conversations] };
  }
  return { ...old, pages };
}

/** Save a conversation's messages (and title). */
export function useSaveConversation() {
  const queryClient = useQueryClient();
  const client = useConversationsClient();
  const labels = useLabels();

  return useMutation({
    retry: 1,
    mutationFn: async ({
      id,
      messages,
      title,
    }: {
      id: string;
      messages: Message[];
      title?: string;
    }): Promise<Conversation> => {
      const lastMessage = messageText(messages[messages.length - 1]).slice(0, 100) || undefined;

      try {
        const { data } = await client.api.post<ApiConversation>(CONVERSATION_ROUTES.save, {
          conversationId: id,
          messages,
          ...(title && { title }),
        });
        return {
          id: data.id,
          title: data.title,
          lastMessage: data.lastMessage,
          source: data.source,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages,
        };
      } catch (error: unknown) {
        // If unauthorized, save to the offline copy
        if (errorStatus(error) === 401) {
          const conversations = await client.offline.read();
          const existingIndex = conversations.findIndex((c) => c.id === id);

          const offlineTitle =
            title ||
            messageText(messages.find((m) => m.role === 'user')).slice(0, 50) ||
            client.newChatTitle;
          const conversation: Conversation = {
            id,
            title: offlineTitle,
            lastMessage,
            createdAt: existingIndex >= 0 ? conversations[existingIndex].createdAt : new Date(),
            updatedAt: new Date(),
            messages,
          };

          const next = [...conversations];
          if (existingIndex >= 0) next[existingIndex] = conversation;
          else next.unshift(conversation);

          await client.offline.write(next);
          return conversation;
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(
        aliaQueryKeys.conversations.all,
        (old: ConversationsInfiniteData | undefined) =>
          upsertOnTop(old, { ...data, messages: [] }, true),
      );
      // Update individual conversation cache with full data including messages
      queryClient.setQueryData(aliaQueryKeys.conversations.detail(data.id), data);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error) || labels.conversationSaveFailed);
    },
  });
}

/**
 * Rename a conversation.
 *
 * The API has no title-only route: `POST /conversations` writes the title AND
 * replaces the messages. So the full thread is read fresh first (`staleTime:
 * 0` — the sidebar seeds the detail cache from the list with no messages, and
 * saving that seed would empty the thread) and saved back with the new title.
 */
export function useRenameConversation() {
  const queryClient = useQueryClient();
  const client = useConversationsClient();
  const save = useSaveConversation();

  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const conversation = await queryClient.fetchQuery({
        queryKey: aliaQueryKeys.conversations.detail(id),
        queryFn: () => fetchConversation(client, id),
        staleTime: 0,
      });
      return save.mutateAsync({ id, messages: conversation.messages, title });
    },
  });
}

/** Delete a conversation. */
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  const client = useConversationsClient();
  const labels = useLabels();

  return useMutation({
    retry: 1,
    mutationFn: async (id: string) => {
      try {
        await client.api.delete(CONVERSATION_ROUTES.remove(id));
      } catch (error: unknown) {
        // If unauthorized, delete from the offline copy
        if (errorStatus(error) === 401) {
          const conversations = await client.offline.read();
          await client.offline.write(conversations.filter((c) => c.id !== id));
        } else {
          throw error;
        }
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData(
        aliaQueryKeys.conversations.all,
        (old: ConversationsInfiniteData | undefined) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              conversations: page.conversations.filter((c) => c.id !== id),
            })),
          };
        },
      );
      queryClient.removeQueries({ queryKey: aliaQueryKeys.conversations.detail(id) });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error) || labels.conversationDeleteFailed);
    },
  });
}

/**
 * Empty a conversation on the server, keeping the conversation.
 *
 * The persistent half of "Clear conversation" (#553). The local half —
 * `setMessages([])` in `useAliaConversation` — is NOT enough on its own: the
 * detail query still holds the history, and the sync effect there treats
 * "cache has messages, screen has none" as a data upgrade and hydrates them
 * straight back, which is the bug. So the cache is emptied HERE, on success
 * only, and the caller resets its screen after `mutateAsync` resolves — by
 * which point React Query has run this `onSuccess`, so there is no longer a
 * history for the effect to restore. Nothing is touched optimistically: a
 * clear the server refused must leave the thread exactly as it was, because
 * the dialog that asked for it promised the opposite of "it will be back".
 *
 * The list entry keeps its place and loses its preview — the server dropped
 * `lastMessage` in the same transaction — and both queries are then
 * invalidated so whatever the server has (the moved `updatedAt`, a title it
 * may have kept) replaces the local guess.
 */
export function useClearConversation() {
  const queryClient = useQueryClient();
  const client = useConversationsClient();

  return useMutation({
    retry: 1,
    mutationFn: async (id: string) => {
      try {
        await client.api.delete(CONVERSATION_ROUTES.clearMessages(id));
      } catch (error: unknown) {
        // If unauthorized, clear the offline copy — the same branch a delete takes.
        if (errorStatus(error) === 401) {
          const conversations = await client.offline.read();
          await client.offline.write(
            conversations.map((c) =>
              c.id === id
                ? { ...c, messages: [], lastMessage: undefined, updatedAt: new Date() }
                : c,
            ),
          );
        } else {
          throw error;
        }
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData(
        aliaQueryKeys.conversations.detail(id),
        (old: Conversation | undefined) =>
          old ? { ...old, messages: [], lastMessage: undefined } : old,
      );
      queryClient.setQueryData(
        aliaQueryKeys.conversations.all,
        (old: ConversationsInfiniteData | undefined) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              conversations: page.conversations.map((c) =>
                c.id === id ? { ...c, lastMessage: undefined } : c,
              ),
            })),
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.detail(id) });
      void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.all });
    },
  });
}

/** Create a conversation (optionally the next stretch of an agent's thread). */
export function useCreateConversation() {
  const queryClient = useQueryClient();
  const client = useConversationsClient();
  const labels = useLabels();

  return useMutation({
    mutationFn: async (params?: { agentId?: string }): Promise<Conversation> => {
      try {
        const { data } = await client.api.post<ApiConversation>(CONVERSATION_ROUTES.create, {
          ...(params?.agentId && { agentId: params.agentId }),
        });
        return {
          id: data.id,
          title: data.title,
          lastMessage: undefined,
          source: data.source,
          agentId: data.agentId,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages: [],
        };
      } catch (error: unknown) {
        // If unauthorized, create it in the offline copy
        if (errorStatus(error) === 401 && client.offline.available) {
          const conversation: Conversation = {
            id: createRandomUuid(),
            title: client.newChatTitle,
            lastMessage: undefined,
            createdAt: new Date(),
            updatedAt: new Date(),
            messages: [],
          };
          await client.offline.write([conversation, ...(await client.offline.read())]);
          return conversation;
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(
        aliaQueryKeys.conversations.all,
        (old: ConversationsInfiniteData | undefined) => upsertOnTop(old, data, false),
      );
      queryClient.setQueryData(aliaQueryKeys.conversations.detail(data.id), data);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error) || labels.conversationCreateFailed);
    },
  });
}
