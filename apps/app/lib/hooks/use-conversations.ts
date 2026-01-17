import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { generateAPIUrl } from '../generate-api-url';
import { useAuthStore } from '../stores/auth-store';

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}

const CONVERSATIONS_STORAGE_KEY = "alia-conversations";

function isAuthenticated(): boolean {
  return !!useAuthStore.getState().token;
}

function getAPIHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// Fetch conversations from API or local storage
async function fetchConversations(): Promise<Conversation[]> {
  if (isAuthenticated()) {
    const apiUrl = generateAPIUrl('/conversations');
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: getAPIHeaders(),
    });

    if (!response.ok) {
      throw new Error('Failed to fetch conversations');
    }

    const data = await response.json();
    return data.conversations.map((conv: any) => ({
      ...conv,
      createdAt: new Date(conv.createdAt),
      updatedAt: new Date(conv.updatedAt),
    }));
  } else {
    const stored = await SecureStore.getItemAsync(CONVERSATIONS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.map((conv: any) => ({
        ...conv,
        createdAt: new Date(conv.createdAt),
        updatedAt: new Date(conv.updatedAt),
      }));
    }
    return [];
  }
}

// Hook to get all conversations
export function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
  });
}

// Fetch a single conversation with messages from API
async function fetchConversation(id: string): Promise<Conversation> {
  if (isAuthenticated()) {
    const apiUrl = generateAPIUrl(`/conversations/${id}`);
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: getAPIHeaders(),
    });

    if (!response.ok) {
      throw new Error('Failed to fetch conversation');
    }

    const data = await response.json();
    return {
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  } else {
    // Local storage - get from conversations array
    const stored = await SecureStore.getItemAsync(CONVERSATIONS_STORAGE_KEY);
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

      if (isAuthenticated()) {
        const apiUrl = generateAPIUrl('/conversations');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: getAPIHeaders(),
          body: JSON.stringify({
            conversationId: id,
            title: conversationTitle,
            messages
          })
        });

        if (!response.ok) {
          throw new Error('Failed to save conversation');
        }

        const data = await response.json();
        return {
          id: data.id,
          title: data.title,
          lastMessage: data.lastMessage,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages
        };
      } else {
        // Local storage
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

        await SecureStore.setItemAsync(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
        return conversation;
      }
    },
    onSuccess: (data) => {
      // Update both the conversations list cache and individual conversation cache
      queryClient.setQueryData<Conversation[]>(['conversations'], (old) => {
        if (!old) return [{ ...data, messages: [] }];
        const existingIndex = old.findIndex((c) => c.id === data.id);
        const newConversations = [...old];
        const conversationMetadata = { ...data, messages: [] }; // List doesn't need messages
        if (existingIndex >= 0) {
          newConversations[existingIndex] = conversationMetadata;
        } else {
          newConversations.unshift(conversationMetadata);
        }
        return newConversations;
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
      if (isAuthenticated()) {
        const apiUrl = generateAPIUrl(`/conversations/${id}`);
        const response = await fetch(apiUrl, {
          method: 'DELETE',
          headers: getAPIHeaders(),
        });

        if (!response.ok) {
          throw new Error('Failed to delete conversation');
        }
      } else {
        const conversations = await fetchConversations();
        const newConversations = conversations.filter((c) => c.id !== id);
        await SecureStore.setItemAsync(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
      }
      return id;
    },
    onSuccess: (id) => {
      // Remove from cache
      queryClient.setQueryData<Conversation[]>(['conversations'], (old) => {
        if (!old) return [];
        return old.filter((c) => c.id !== id);
      });
    },
  });
}

// Create a new conversation
export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<Conversation> => {
      if (isAuthenticated()) {
        // Call backend to create new conversation
        const apiUrl = generateAPIUrl('/conversations/new');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: getAPIHeaders(),
        });

        if (!response.ok) {
          throw new Error('Failed to create conversation');
        }

        const data = await response.json();
        return {
          id: data.id,
          title: data.title,
          lastMessage: undefined,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages: [],
        };
      } else {
        // For unauthenticated users, generate UUID locally
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
        await SecureStore.setItemAsync(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));

        return conversation;
      }
    },
    onSuccess: (data) => {
      // Add to conversations list cache
      queryClient.setQueryData<Conversation[]>(['conversations'], (old) => {
        if (!old) return [data];
        const exists = old.findIndex((c) => c.id === data.id) >= 0;
        if (exists) return old;
        return [data, ...old];
      });

      // Set individual conversation cache
      queryClient.setQueryData(['conversation', data.id], data);
    },
  });
}
