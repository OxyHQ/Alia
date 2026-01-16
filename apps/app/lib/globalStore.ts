import { create } from "zustand";
import * as SecureStore from 'expo-secure-store';
import { generateAPIUrl } from "./generate-api-url";
import { useAuthStore } from "./stores/auth-store";

type ChatIdState = {
  id: string;
  from: "history" | "newChat" | "sidebar" | "url";
} | null;

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

interface StoreState {
  scrollY: number;
  setScrollY: (value: number) => void;
  selectedImageUris: string[];
  addImageUri: (uri: string) => void;
  removeImageUri: (uri: string) => void;
  clearImageUris: () => void;
  setBottomChatHeightHandler: (value: boolean) => void;
  bottomChatHeightHandler: boolean;
  chatId: ChatIdState;
  setChatId: (value: { id: string; from: "history" | "newChat" | "sidebar" | "url" } | null) => void;
  setFocusKeyboard: (value: boolean) => void;
  focusKeyboard: boolean;

  pendingInitialMessage: string | null;
  setPendingInitialMessage: (message: string) => void;
  clearPendingInitialMessage: () => void;

  conversations: Conversation[];
  conversationsLoaded: boolean;
  loadConversations: () => Promise<void>;
  createEmptyConversation: (id: string) => Promise<void>;
  saveConversation: (id: string, messages: Message[], title?: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  loadConversationMessages: (id: string) => Message[];
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

export const useStore = create<StoreState>((set, get) => ({
  scrollY: 0,
  setScrollY: (value: number) => set({ scrollY: value }),
  selectedImageUris: [],
  addImageUri: (uri: string) =>
    set((state) => ({
      selectedImageUris: [...state.selectedImageUris, uri],
    })),
  removeImageUri: (uri: string) =>
    set((state) => ({
      selectedImageUris: state.selectedImageUris.filter(
        (imageUri) => imageUri !== uri,
      ),
    })),
  clearImageUris: () => set({ selectedImageUris: [] }),
  bottomChatHeightHandler: false,
  setBottomChatHeightHandler: (value: boolean) =>
    set({ bottomChatHeightHandler: value }),
  chatId: null,
  setChatId: (value) => set({ chatId: value }),
  focusKeyboard: false,
  setFocusKeyboard: (value: boolean) => set({ focusKeyboard: value }),

  pendingInitialMessage: null,
  setPendingInitialMessage: (message: string) => set({ pendingInitialMessage: message }),
  clearPendingInitialMessage: () => set({ pendingInitialMessage: null }),

  conversations: [],
  conversationsLoaded: false,

  loadConversations: async () => {
    const state = get();
    if (state.conversationsLoaded) return;

    try {
      if (isAuthenticated()) {
        const apiUrl = generateAPIUrl('/conversations');
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: getAPIHeaders(),
        });

        if (response.ok) {
          const data = await response.json();
          const conversations = data.conversations.map((conv: any) => ({
            ...conv,
            createdAt: new Date(conv.createdAt),
            updatedAt: new Date(conv.updatedAt),
          }));
          set({ conversations, conversationsLoaded: true });
        } else {
          console.error('Failed to load conversations:', response.status);
          set({ conversationsLoaded: true });
        }
      } else {
        const stored = await SecureStore.getItemAsync(CONVERSATIONS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          const conversations = parsed.map((conv: any) => ({
            ...conv,
            createdAt: new Date(conv.createdAt),
            updatedAt: new Date(conv.updatedAt),
          }));
          set({ conversations, conversationsLoaded: true });
        } else {
          set({ conversationsLoaded: true });
        }
      }
    } catch (error) {
      console.error("Error loading conversations:", error);
      set({ conversationsLoaded: true });
    }
  },

  createEmptyConversation: async (id: string) => {
    try {
      const state = get();
      if (state.conversations.findIndex((c) => c.id === id) >= 0) return;

      const conversation: Conversation = {
        id,
        title: "Nueva conversación",
        lastMessage: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
      };

      const newConversations = [conversation, ...state.conversations];

      if (!isAuthenticated()) {
        await SecureStore.setItemAsync(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
      }

      set({ conversations: newConversations });
    } catch (error) {
      console.error("Error creating conversation:", error);
    }
  },

  saveConversation: async (id: string, messages: Message[], title?: string) => {
    try {
      const state = get();
      const existingIndex = state.conversations.findIndex((c) => c.id === id);
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

        if (response.ok) {
          const data = await response.json();
          const conversation: Conversation = {
            id: data.id,
            title: data.title,
            lastMessage: data.lastMessage,
            createdAt: new Date(data.createdAt),
            updatedAt: new Date(data.updatedAt),
            messages
          };

          const newConversations = [...state.conversations];
          if (existingIndex >= 0) {
            newConversations[existingIndex] = conversation;
          } else {
            newConversations.unshift(conversation);
          }
          set({ conversations: newConversations });
        } else {
          console.error('Failed to save conversation:', response.status);
        }
      } else {
        const conversation: Conversation = {
          id,
          title: conversationTitle,
          lastMessage,
          createdAt: existingIndex >= 0 ? state.conversations[existingIndex].createdAt : new Date(),
          updatedAt: new Date(),
          messages,
        };

        const newConversations = [...state.conversations];
        if (existingIndex >= 0) {
          newConversations[existingIndex] = conversation;
        } else {
          newConversations.unshift(conversation);
        }

        await SecureStore.setItemAsync(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
        set({ conversations: newConversations });
      }
    } catch (error) {
      console.error("Error saving conversation:", error);
    }
  },

  deleteConversation: async (id: string) => {
    try {
      const state = get();
      const newConversations = state.conversations.filter((c) => c.id !== id);

      if (isAuthenticated()) {
        const apiUrl = generateAPIUrl(`/conversations/${id}`);
        const response = await fetch(apiUrl, {
          method: 'DELETE',
          headers: getAPIHeaders(),
        });

        if (response.ok) {
          set({ conversations: newConversations });
        } else {
          console.error('Failed to delete conversation:', response.status);
        }
      } else {
        await SecureStore.setItemAsync(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
        set({ conversations: newConversations });
      }
    } catch (error) {
      console.error("Error deleting conversation:", error);
    }
  },

  loadConversationMessages: (id: string) => {
    const state = get();
    const conversation = state.conversations.find((c) => c.id === id);
    return conversation?.messages || [];
  },
}));
