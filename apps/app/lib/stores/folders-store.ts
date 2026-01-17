import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Folder {
  id: string;
  name: string;
  icon?: string; // Lucide icon name
  color?: string;
  conversationIds: string[];
  isExpanded: boolean;
  isFavorite?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FoldersStoreState {
  folders: Folder[];
  loadFolders: () => Promise<void>;
  createFolder: (name: string, icon?: string) => Promise<void>;
  updateFolder: (id: string, updates: Partial<Folder>) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  toggleFolder: (id: string) => Promise<void>;
  addConversationToFolder: (folderId: string, conversationId: string) => Promise<void>;
  removeConversationFromFolder: (folderId: string, conversationId: string) => Promise<void>;
}

const FOLDERS_STORAGE_KEY = "alia-folders";

export const useFoldersStore = create<FoldersStoreState>((set, get) => ({
  folders: [],

  loadFolders: async () => {
    try {
      const foldersData = await AsyncStorage.getItem(FOLDERS_STORAGE_KEY);

      if (foldersData) {
        const parsed = JSON.parse(foldersData);
        const folders = parsed.map((folder: any) => ({
          ...folder,
          createdAt: new Date(folder.createdAt),
          updatedAt: new Date(folder.updatedAt),
        }));
        set({ folders });
      }
    } catch (error) {
      console.error("Error loading folders:", error);
    }
  },

  createFolder: async (name: string, icon?: string) => {
    try {
      const state = get();
      const folder: Folder = {
        id: `folder-${Date.now()}`,
        name,
        icon: icon || getRandomIcon(),
        color: getRandomColor(),
        conversationIds: [],
        isExpanded: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const newFolders = [...state.folders, folder];
      await AsyncStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(newFolders));
      set({ folders: newFolders });
    } catch (error) {
      console.error("Error creating folder:", error);
    }
  },

  updateFolder: async (id: string, updates: Partial<Folder>) => {
    try {
      const state = get();
      const newFolders = state.folders.map((folder) =>
        folder.id === id
          ? { ...folder, ...updates, updatedAt: new Date() }
          : folder
      );
      await AsyncStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(newFolders));
      set({ folders: newFolders });
    } catch (error) {
      console.error("Error updating folder:", error);
    }
  },

  deleteFolder: async (id: string) => {
    try {
      const state = get();
      const newFolders = state.folders.filter((folder) => folder.id !== id);
      await AsyncStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(newFolders));
      set({ folders: newFolders });
    } catch (error) {
      console.error("Error deleting folder:", error);
    }
  },

  toggleFolder: async (id: string) => {
    try {
      const state = get();
      const newFolders = state.folders.map((folder) =>
        folder.id === id
          ? { ...folder, isExpanded: !folder.isExpanded, updatedAt: new Date() }
          : folder
      );
      await AsyncStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(newFolders));
      set({ folders: newFolders });
    } catch (error) {
      console.error("Error toggling folder:", error);
    }
  },

  addConversationToFolder: async (folderId: string, conversationId: string) => {
    try {
      const state = get();
      const newFolders = state.folders.map((folder) => {
        if (folder.id === folderId && !folder.conversationIds.includes(conversationId)) {
          return {
            ...folder,
            conversationIds: [...folder.conversationIds, conversationId],
            updatedAt: new Date(),
          };
        }
        return folder;
      });
      await AsyncStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(newFolders));
      set({ folders: newFolders });
    } catch (error) {
      console.error("Error adding conversation to folder:", error);
    }
  },

  removeConversationFromFolder: async (folderId: string, conversationId: string) => {
    try {
      const state = get();
      const newFolders = state.folders.map((folder) => {
        if (folder.id === folderId) {
          return {
            ...folder,
            conversationIds: folder.conversationIds.filter((id) => id !== conversationId),
            updatedAt: new Date(),
          };
        }
        return folder;
      });
      await AsyncStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(newFolders));
      set({ folders: newFolders });
    } catch (error) {
      console.error("Error removing conversation from folder:", error);
    }
  },
}));

// Helper function to generate random colors for folders
function getRandomColor(): string {
  const colors = [
    "#3b82f6", // blue
    "#8b5cf6", // purple
    "#ec4899", // pink
    "#f59e0b", // amber
    "#10b981", // green
    "#06b6d4", // cyan
    "#f97316", // orange
    "#ef4444", // red
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Helper function to generate random icons for folders
function getRandomIcon(): string {
  const icons = [
    "Folder",
    "FolderOpen",
    "FolderClosed",
    "Archive",
    "Inbox",
    "BookMarked",
  ];
  return icons[Math.floor(Math.random() * icons.length)];
}
