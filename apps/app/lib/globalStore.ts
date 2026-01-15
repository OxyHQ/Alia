import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Message } from "@ai-sdk/react";

type ChatIdState = {
  id: string;
  from: "history" | "newChat" | "sidebar";
} | null;

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
  setChatId: (value: { id: string; from: "history" | "newChat" | "sidebar" }) => void;
  setFocusKeyboard: (value: boolean) => void;
  focusKeyboard: boolean;

  // Conversations
  conversations: Conversation[];
  loadConversations: () => Promise<void>;
  saveConversation: (id: string, messages: Message[], title?: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  loadConversationMessages: (id: string) => Message[];
}

const CONVERSATIONS_STORAGE_KEY = "alia-conversations";

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

  // Conversations
  conversations: [],

  loadConversations: async () => {
    try {
      const stored = await AsyncStorage.getItem(CONVERSATIONS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Convert date strings back to Date objects
        const conversations = parsed.map((conv: any) => ({
          ...conv,
          createdAt: new Date(conv.createdAt),
          updatedAt: new Date(conv.updatedAt),
        }));
        set({ conversations });
      }
    } catch (error) {
      console.error("Error loading conversations:", error);
    }
  },

  saveConversation: async (id: string, messages: Message[], title?: string) => {
    try {
      const state = get();
      const existingIndex = state.conversations.findIndex((c) => c.id === id);

      // Generate title from first user message if not provided
      const conversationTitle = title || messages.find((m) => m.role === "user")?.content?.slice(0, 50) || "Nueva conversación";
      const lastMessage = messages[messages.length - 1]?.content?.slice(0, 100);

      const conversation: Conversation = {
        id,
        title: conversationTitle,
        lastMessage,
        createdAt: existingIndex >= 0 ? state.conversations[existingIndex].createdAt : new Date(),
        updatedAt: new Date(),
        messages,
      };

      let newConversations: Conversation[];
      if (existingIndex >= 0) {
        // Update existing conversation
        newConversations = [...state.conversations];
        newConversations[existingIndex] = conversation;
      } else {
        // Add new conversation at the beginning
        newConversations = [conversation, ...state.conversations];
      }

      // Save to AsyncStorage
      await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
      set({ conversations: newConversations });
    } catch (error) {
      console.error("Error saving conversation:", error);
    }
  },

  deleteConversation: async (id: string) => {
    try {
      const state = get();
      const newConversations = state.conversations.filter((c) => c.id !== id);
      await AsyncStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(newConversations));
      set({ conversations: newConversations });
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
