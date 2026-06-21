import { create } from "zustand";
import { CollectionPersister, type CollectionItem } from "./create-collection-store";

export interface Folder extends CollectionItem {
  isFavorite?: boolean;
}

const FOLDER_ICONS = ["Folder", "FolderOpen", "FolderClosed", "Archive", "Inbox", "BookMarked"];
const persister = new CollectionPersister<Folder>("alia-folders", "folder", FOLDER_ICONS);

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

export const useFoldersStore = create<FoldersStoreState>((set, get) => ({
  folders: [],

  loadFolders: async () => {
    try {
      set({ folders: await persister.load() });
    } catch (error) {
      console.error("Error loading folders:", error);
    }
  },

  createFolder: async (name: string, icon?: string) => {
    try {
      const folder = persister.newItem(name, icon ? { icon } as Partial<Folder> : undefined);
      const folders = [...get().folders, folder];
      await persister.save(folders);
      set({ folders });
    } catch (error) {
      console.error("Error creating folder:", error);
    }
  },

  updateFolder: async (id: string, updates: Partial<Folder>) => {
    try {
      const folders = persister.updateIn(get().folders, id, updates);
      await persister.save(folders);
      set({ folders });
    } catch (error) {
      console.error("Error updating folder:", error);
    }
  },

  deleteFolder: async (id: string) => {
    try {
      const folders = get().folders.filter((f) => f.id !== id);
      await persister.save(folders);
      set({ folders });
    } catch (error) {
      console.error("Error deleting folder:", error);
    }
  },

  toggleFolder: async (id: string) => {
    try {
      const folders = get().folders.map((f) =>
        f.id === id ? { ...f, isExpanded: !f.isExpanded } : f
      );
      await persister.save(folders);
      set({ folders });
    } catch (error) {
      console.error("Error toggling folder:", error);
    }
  },

  addConversationToFolder: async (folderId: string, conversationId: string) => {
    try {
      const folders = persister.addConversation(get().folders, folderId, conversationId);
      await persister.save(folders);
      set({ folders });
    } catch (error) {
      console.error("Error adding conversation to folder:", error);
    }
  },

  removeConversationFromFolder: async (folderId: string, conversationId: string) => {
    try {
      const folders = persister.removeConversation(get().folders, folderId, conversationId);
      await persister.save(folders);
      set({ folders });
    } catch (error) {
      console.error("Error removing conversation from folder:", error);
    }
  },
}));
