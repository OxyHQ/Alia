import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
  vote?: 'up' | 'down';
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  folderId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: Date;
}

interface ChatState {
  conversations: Conversation[];
  folders: Folder[];
  currentConversationId: string | null;
  selectedModel: string;

  // Conversation actions
  createConversation: (title?: string, folderId?: string) => string;
  deleteConversation: (id: string) => void;
  updateConversation: (id: string, data: Partial<Conversation>) => void;
  setCurrentConversation: (id: string | null) => void;
  getCurrentConversation: () => Conversation | null;

  // Message actions
  addMessage: (conversationId: string, message: Omit<Message, 'id' | 'createdAt'>) => void;
  updateMessage: (conversationId: string, messageId: string, data: Partial<Message>) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;

  // Folder actions
  createFolder: (name: string) => string;
  deleteFolder: (id: string) => void;
  updateFolder: (id: string, name: string) => void;

  // Model selection
  setSelectedModel: (model: string) => void;

  // Clear all data
  clearAll: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      folders: [],
      currentConversationId: null,
      selectedModel: 'alia-v1',

      createConversation: (title = 'Nueva conversación', folderId) => {
        const id = `conv_${Date.now()}`;
        const newConversation: Conversation = {
          id,
          title,
          messages: [],
          folderId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          currentConversationId: id,
        }));

        return id;
      },

      deleteConversation: (id) =>
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          currentConversationId:
            state.currentConversationId === id ? null : state.currentConversationId,
        })),

      updateConversation: (id, data) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, ...data, updatedAt: new Date() } : c
          ),
        })),

      setCurrentConversation: (id) =>
        set({ currentConversationId: id }),

      getCurrentConversation: () => {
        const state = get();
        return (
          state.conversations.find((c) => c.id === state.currentConversationId) || null
        );
      },

      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [
                    ...c.messages,
                    {
                      ...message,
                      id: `msg_${Date.now()}`,
                      createdAt: new Date(),
                    },
                  ],
                  updatedAt: new Date(),
                }
              : c
          ),
        })),

      updateMessage: (conversationId, messageId, data) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, ...data } : m
                  ),
                  updatedAt: new Date(),
                }
              : c
          ),
        })),

      deleteMessage: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.filter((m) => m.id !== messageId),
                  updatedAt: new Date(),
                }
              : c
          ),
        })),

      createFolder: (name) => {
        const id = `folder_${Date.now()}`;
        const newFolder: Folder = {
          id,
          name,
          createdAt: new Date(),
        };

        set((state) => ({
          folders: [...state.folders, newFolder],
        }));

        return id;
      },

      deleteFolder: (id) =>
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          conversations: state.conversations.map((c) =>
            c.folderId === id ? { ...c, folderId: undefined } : c
          ),
        })),

      updateFolder: (id, name) =>
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
        })),

      setSelectedModel: (model) =>
        set({ selectedModel: model }),

      clearAll: () =>
        set({
          conversations: [],
          folders: [],
          currentConversationId: null,
          selectedModel: 'alia-v1',
        }),
    }),
    {
      name: 'chat-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
