import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { toast } from '@/components/sonner';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import type { ToolInvocation } from '../types/messages';
import { errorMessage as getErrorMessage, errorStatus } from '../errors/error-utils';

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; [key: string]: any }>;
  thinking?: string; // Extended thinking content (when thinking mode is enabled)
  toolInvocations?: ToolInvocation[];
  // Voice fields (optional, only present for voice-originated messages)
  source?: 'text' | 'voice';
  speaker?: 'primary' | 'cohost';
  isStreaming?: boolean;
  // Agent delegation metadata (when agent mode delegates to a specialist agent)
  agentInfo?: {
    id: string;
    name: string;
    avatar: string | null;
    handle: string;
  };
  audioUrl?: string;
}

export interface Conversation {
  id: string;
  title: string;
  lastMessage?: string;
  source?: string;
  agentId?: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}

const CONVERSATIONS_STORAGE_KEY = "alia-conversations";

// Fetch all conversations from local storage (offline fallback)
async function fetchConversations(): Promise<Conversation[]> {
  const stored = await AsyncStorage.getItem(CONVERSATIONS_STORAGE_KEY);
  if (stored) {
    return JSON.parse(stored).map((conv: Conversation) => ({
      ...conv,
      createdAt: new Date(conv.createdAt),
      updatedAt: new Date(conv.updatedAt),
    }));
  }
  return [];
}

// Fetch conversations from API or local storage (paginated)
async function fetchConversationsPage({ pageParam }: { pageParam?: string }): Promise<{
  conversations: Conversation[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  try {
    const params: any = { limit: 20 };
    if (pageParam) {
      params.cursor = pageParam;
    }

    const response = await apiClient.get('/conversations', { params });
    return {
      conversations: response.data.conversations.map((conv: any) => ({
        ...conv,
        createdAt: new Date(conv.createdAt),
        updatedAt: new Date(conv.updatedAt),
        messages: [], // Don't include messages in list view
      })),
      nextCursor: response.data.nextCursor,
      hasMore: response.data.hasMore,
    };
  } catch (error: unknown) {
    // If unauthorized, fall back to local storage
    if (errorStatus(error) === 401) {
      const conversations = (await fetchConversations()).map((c) => ({ ...c, messages: [] as Message[] }));
      const offset = pageParam ? parseInt(pageParam) : 0;
      const limit = 20;
      const page = conversations.slice(offset, offset + limit);

      return {
        conversations: page,
        nextCursor: offset + limit < conversations.length ? String(offset + limit) : null,
        hasMore: offset + limit < conversations.length,
      };
    }
    throw error;
  }
}

// Hook to get all conversations with infinite scroll
export function useConversations() {
  const { isAuthenticated } = useOxy();

  return useInfiniteQuery({
    queryKey: queryKeys.conversations.all,
    queryFn: fetchConversationsPage,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

// Fetch a single conversation with messages from API
async function fetchConversation(id: string): Promise<Conversation> {
  try {
    const response = await apiClient.get(`/conversations/${id}`);
    const data = response.data;
    return {
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  } catch (error: unknown) {
    // If unauthorized or not found on server, fall back to local storage
    if (errorStatus(error) === 401 || errorStatus(error) === 404) {
      const stored = await AsyncStorage.getItem(CONVERSATIONS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const conversation = parsed.find((c: any) => c.id === id);
        if (conversation) {
          return {
            ...conversation,
            createdAt: new Date(conversation.createdAt),
            updatedAt: new Date(conversation.updatedAt),
          };
        }
      }
    }
    throw new Error('Conversation not found');
  }
}

// Hook to get a single conversation with messages
export function useConversation(id: string) {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.conversations.detail(id),
    queryFn: () => fetchConversation(id),
    enabled: isAuthenticated && !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 1,
  });
}

// Prefetch a conversation detail (call from sidebar on press-in / hover)
export function prefetchConversation(queryClient: QueryClient, id: string) {
  queryClient.prefetchQuery({
    queryKey: queryKeys.conversations.detail(id),
    queryFn: () => fetchConversation(id),
    staleTime: 1000 * 60 * 5,
  });
}

// Save conversation mutation
export function useSaveConversation() {
  const queryClient = useQueryClient();

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
    }) => {
      const lastMessage = messages[messages.length - 1]?.content?.slice(0, 100);

      try {
        const response = await apiClient.post('/conversations', {
          conversationId: id,
          messages,
          ...(title && { title }),
        });

        const data = response.data;
        return {
          id: data.id,
          title: data.title,
          lastMessage: data.lastMessage,
          source: data.source,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages
        };
      } catch (error: unknown) {
        // If unauthorized, save to local storage
        if (errorStatus(error) === 401) {
          const conversations = await fetchConversations();
          const existingIndex = conversations.findIndex((c) => c.id === id);

          const offlineTitle = title || messages.find((m) => m.role === "user")?.content?.slice(0, 50) || "New chat";
          const conversation: Conversation = {
            id,
            title: offlineTitle,
            lastMessage,
            createdAt: existingIndex >= 0 ? conversations[existingIndex].createdAt : new Date(),
            updatedAt: new Date(),
            messages,
          };

          const newConversations = [...conversations];
          if (existingIndex >= 0) {
            newConversations[existingIndex] = conversation;
          } else {
            newConversations.unshift(conversation);
          }

          await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
          return conversation;
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      // Update infinite query cache
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: any) => {
        if (!oldData?.pages) {
          return {
            pages: [{
              conversations: [{ ...data, messages: [] }],
              nextCursor: null,
              hasMore: false,
            }],
            pageParams: [undefined],
          };
        }

        const newPages = [...oldData.pages];
        const conversationMetadata = { ...data, messages: [] };

        // Remove conversation from its current position (if it exists in any page)
        for (let i = 0; i < newPages.length; i++) {
          const existingIndex = newPages[i].conversations.findIndex((c: Conversation) => c.id === data.id);
          if (existingIndex >= 0) {
            newPages[i] = {
              ...newPages[i],
              conversations: [
                ...newPages[i].conversations.slice(0, existingIndex),
                ...newPages[i].conversations.slice(existingIndex + 1),
              ],
            };
            break;
          }
        }

        // Always add to top of first page (most recently updated first)
        if (newPages[0]) {
          newPages[0] = {
            ...newPages[0],
            conversations: [conversationMetadata, ...newPages[0].conversations],
          };
        }

        return {
          ...oldData,
          pages: newPages,
        };
      });

      // Update individual conversation cache with full data including messages
      queryClient.setQueryData(queryKeys.conversations.detail(data.id), data);
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error) || 'Failed to save conversation');
    },
  });
}

// Delete conversation mutation
export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    retry: 1,
    mutationFn: async (id: string) => {
      try {
        await apiClient.delete(`/conversations/${id}`);
      } catch (error: unknown) {
        // If unauthorized, delete from local storage
        if (errorStatus(error) === 401) {
          const conversations = await fetchConversations();
          const newConversations = conversations.filter((c) => c.id !== id);
          await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
        } else {
          throw error;
        }
      }
      return id;
    },
    onSuccess: (id) => {
      // Remove from infinite query cache
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: any) => {
        if (!oldData?.pages) return oldData;

        return {
          ...oldData,
          pages: oldData.pages.map((page: any) => ({
            ...page,
            conversations: page.conversations.filter((c: Conversation) => c.id !== id),
          })),
        };
      });

      // Invalidate individual conversation cache
      queryClient.removeQueries({ queryKey: queryKeys.conversations.detail(id) });
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error) || 'Failed to delete conversation');
    },
  });
}

// Create a new conversation
export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params?: { agentId?: string }): Promise<Conversation> => {
      try {
        const response = await apiClient.post('/conversations/new', {
          ...(params?.agentId && { agentId: params.agentId }),
        });
        const data = response.data;
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
        // If unauthorized, create locally
        if (errorStatus(error) === 401) {
          const { generateUUID } = await import('../utils');
          const id = generateUUID();
          const conversation: Conversation = {
            id,
            title: "New chat",
            lastMessage: undefined,
            createdAt: new Date(),
            updatedAt: new Date(),
            messages: [],
          };

          const conversations = await fetchConversations();
          const newConversations = [conversation, ...conversations];
          await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));

          return conversation;
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      // Add to first page of infinite query cache
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: any) => {
        if (!oldData?.pages) {
          return {
            pages: [{
              conversations: [data],
              nextCursor: null,
              hasMore: false,
            }],
            pageParams: [undefined],
          };
        }

        const newPages = [...oldData.pages];
        if (newPages[0]) {
          // Check if already exists
          const exists = newPages[0].conversations.some((c: Conversation) => c.id === data.id);
          if (!exists) {
            newPages[0] = {
              ...newPages[0],
              conversations: [data, ...newPages[0].conversations],
            };
          }
        }

        return {
          ...oldData,
          pages: newPages,
        };
      });

      // Set individual conversation cache
      queryClient.setQueryData(queryKeys.conversations.detail(data.id), data);
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error) || 'Failed to create conversation');
    },
  });
}
