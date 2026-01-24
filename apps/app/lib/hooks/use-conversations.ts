import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../api/client';

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string; // Extended thinking content (when thinking mode is enabled)
  toolInvocations?: {
    toolCallId: string;
    toolName: string;
    state: 'partial-call' | 'call' | 'result';
    args?: any;
    result?: any;
  }[];
}

export interface Conversation {
  id: string;
  title: string;
  lastMessage?: string;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}

const CONVERSATIONS_STORAGE_KEY = "alia-conversations";

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
  } catch (error: any) {
    // If unauthorized, fall back to local storage
    if (error.response?.status === 401) {
      const stored = await AsyncStorage.getItem(CONVERSATIONS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const conversations = parsed.map((conv: any) => ({
          ...conv,
          createdAt: new Date(conv.createdAt),
          updatedAt: new Date(conv.updatedAt),
          messages: [],
        }));

        // Simple pagination for local storage
        const offset = pageParam ? parseInt(pageParam) : 0;
        const limit = 20;
        const page = conversations.slice(offset, offset + limit);

        return {
          conversations: page,
          nextCursor: offset + limit < conversations.length ? String(offset + limit) : null,
          hasMore: offset + limit < conversations.length,
        };
      }
      return { conversations: [], nextCursor: null, hasMore: false };
    }
    throw error;
  }
}

// Hook to get all conversations with infinite scroll
export function useConversations() {
  return useInfiniteQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversationsPage,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
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
  } catch (error: any) {
    // If unauthorized, fall back to local storage
    if (error.response?.status === 401) {
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
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () => fetchConversation(id),
    enabled: !!id,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 1,
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
      const conversationTitle = title || messages.find((m) => m.role === "user")?.content?.slice(0, 50) || "Nueva conversación";
      const lastMessage = messages[messages.length - 1]?.content?.slice(0, 100);

      try {
        const response = await apiClient.post('/conversations', {
          conversationId: id,
          title: conversationTitle,
          messages
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
      } catch (error: any) {
        // If unauthorized, save to local storage
        if (error.response?.status === 401) {
          const conversations = await fetchConversations();
          const existingIndex = conversations.findIndex((c) => c.id === id);

          const conversation: Conversation = {
            id,
            title: conversationTitle,
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
      queryClient.setQueryData(['conversations'], (oldData: any) => {
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

        // Check if conversation exists in any page
        let found = false;
        for (let i = 0; i < newPages.length; i++) {
          const existingIndex = newPages[i].conversations.findIndex((c: Conversation) => c.id === data.id);
          if (existingIndex >= 0) {
            newPages[i] = {
              ...newPages[i],
              conversations: [
                ...newPages[i].conversations.slice(0, existingIndex),
                conversationMetadata,
                ...newPages[i].conversations.slice(existingIndex + 1),
              ],
            };
            found = true;
            break;
          }
        }

        // If not found, add to first page
        if (!found && newPages[0]) {
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
      queryClient.setQueryData(['conversation', data.id], data);
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
      } catch (error: any) {
        // If unauthorized, delete from local storage
        if (error.response?.status === 401) {
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
      queryClient.setQueryData(['conversations'], (oldData: any) => {
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
      queryClient.removeQueries({ queryKey: ['conversation', id] });
    },
  });
}

// Create a new conversation
export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<Conversation> => {
      try {
        const response = await apiClient.post('/conversations/new');
        const data = response.data;
        return {
          id: data.id,
          title: data.title,
          lastMessage: undefined,
          source: data.source,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages: [],
        };
      } catch (error: any) {
        // If unauthorized, create locally
        if (error.response?.status === 401) {
          const { generateUUID } = await import('../utils');
          const id = generateUUID();
          const conversation: Conversation = {
            id,
            title: "Nueva conversación",
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
      queryClient.setQueryData(['conversations'], (oldData: any) => {
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
      queryClient.setQueryData(['conversation', data.id], data);
    },
  });
}
