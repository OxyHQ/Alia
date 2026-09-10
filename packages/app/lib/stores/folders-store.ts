import { create } from "zustand";
import { CollectionPersister, type CollectionItem } from "./create-collection-store";

export interface Folder extends CollectionItem {
  isFavorite?: boolean;
}

const FOLDER_ICONS = ["Folder", "FolderOpen", "FolderClosed", "Archive", "Inbox", "BookMarked"];
const persister = new CollectionPersister<Folder>("alia-folders", "folder", FOLDER_ICONS);

interface FoldersStoreState {
  folders: Folder[];
  /**
   * Bind the store to the signed-in account and load its folders. `null`
   * (signed out) empties the list and reads nothing. The layout calls this
   * whenever the user id changes; see `AccountScopedKey` for the namespace,
   * the one-time legacy migration and the stale-load guard.
   */
  loadFolders: (userId: string | null) => Promise<void>;
  createFolder: (name: string, icon?: string) => Promise<void>;
  updateFolder: (id: string, updates: Partial<Folder>) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  toggleFolder: (id: string) => Promise<void>;
  addConversationToFolder: (folderId: string, conversationId: string) => Promise<void>;
  removeConversationFromFolder: (folderId: string, conversationId: string) => Promise<void>;
}

export const useFoldersStore = create<FoldersStoreState>((set, get) => {
  // Persist, then publish — unless the account changed while the write was in
  // flight, in which case the list belongs to the previous account and must
  // not appear under the new one.
  const commit = async (folders: Folder[]) => {
    const token = persister.storage.token;
    await persister.save(folders);
    if (persister.storage.isCurrent(token)) set({ folders });
  };

  return {
    folders: [],

    loadFolders: async (userId) => {
      // Empty synchronously: the previous account's folders must not stay on
      // screen for the duration of the read, and a signed-out state has none.
      const token = persister.storage.bind(userId);
      set({ folders: [] });
      if (!userId) return;
      try {
        const folders = await persister.load();
        if (!persister.storage.isCurrent(token)) return;
        set({ folders });
      } catch (error) {
        console.error("Error loading folders:", error);
      }
    },

    createFolder: async (name: string, icon?: string) => {
      try {
        const folder = persister.newItem(name, icon ? { icon } as Partial<Folder> : undefined);
        await commit([...get().folders, folder]);
      } catch (error) {
        console.error("Error creating folder:", error);
      }
    },

    updateFolder: async (id: string, updates: Partial<Folder>) => {
      try {
        await commit(persister.updateIn(get().folders, id, updates));
      } catch (error) {
        console.error("Error updating folder:", error);
      }
    },

    deleteFolder: async (id: string) => {
      try {
        await commit(get().folders.filter((f) => f.id !== id));
      } catch (error) {
        console.error("Error deleting folder:", error);
      }
    },

    toggleFolder: async (id: string) => {
      try {
        await commit(get().folders.map((f) =>
          f.id === id ? { ...f, isExpanded: !f.isExpanded } : f
        ));
      } catch (error) {
        console.error("Error toggling folder:", error);
      }
    },

    addConversationToFolder: async (folderId: string, conversationId: string) => {
      try {
        await commit(persister.addConversation(get().folders, folderId, conversationId));
      } catch (error) {
        console.error("Error adding conversation to folder:", error);
      }
    },

    removeConversationFromFolder: async (folderId: string, conversationId: string) => {
      try {
        await commit(persister.removeConversation(get().folders, folderId, conversationId));
      } catch (error) {
        console.error("Error removing conversation from folder:", error);
      }
    },
  };
});
