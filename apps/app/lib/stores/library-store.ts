import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type FileCategory = "documents" | "images" | "other";

export interface LibraryFile {
  id: string;
  name: string;
  uri: string;
  type: string; // MIME type
  size: number; // in bytes
  category: FileCategory;
  uploadedAt: Date;
  thumbnail?: string; // For images
}

interface LibraryStoreState {
  files: LibraryFile[];
  loading: boolean;
  loadFiles: () => Promise<void>;
  addFile: (file: Omit<LibraryFile, 'id' | 'uploadedAt'>) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  getFilesByCategory: (category: FileCategory) => LibraryFile[];
  searchFiles: (query: string) => LibraryFile[];
}

const LIBRARY_STORAGE_KEY = "alia-library";
const LIBRARY_SCHEMA_VERSION = "1.0";
const LIBRARY_VERSION_KEY = "alia-library-version";

export const useLibraryStore = create<LibraryStoreState>((set, get) => ({
  files: [],
  loading: false,

  loadFiles: async () => {
    try {
      set({ loading: true });
      const [filesData, storedVersion] = await Promise.all([
        AsyncStorage.getItem(LIBRARY_STORAGE_KEY),
        AsyncStorage.getItem(LIBRARY_VERSION_KEY),
      ]);

      let files: LibraryFile[] = [];

      // Check if schema version changed
      const needsReset = !storedVersion || storedVersion !== LIBRARY_SCHEMA_VERSION;

      if (filesData && !needsReset) {
        try {
          const parsed = JSON.parse(filesData);
          files = parsed.map((file: any) => ({
            ...file,
            uploadedAt: new Date(file.uploadedAt),
          }));
        } catch (parseError) {
          console.error("Error parsing library data:", parseError);
        }
      }

      // Set version if needed
      if (needsReset) {
        await AsyncStorage.setItem(LIBRARY_VERSION_KEY, LIBRARY_SCHEMA_VERSION);
      }

      set({ files, loading: false });
    } catch (error) {
      console.error("Error loading library files:", error);
      set({ loading: false });
    }
  },

  addFile: async (fileData) => {
    try {
      const state = get();
      const file: LibraryFile = {
        ...fileData,
        id: `file-${Date.now()}`,
        uploadedAt: new Date(),
      };

      const newFiles = [...state.files, file];
      await Promise.all([
        AsyncStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(newFiles)),
        AsyncStorage.setItem(LIBRARY_VERSION_KEY, LIBRARY_SCHEMA_VERSION),
      ]);
      set({ files: newFiles });
    } catch (error) {
      console.error("Error adding file:", error);
      throw error;
    }
  },

  deleteFile: async (id: string) => {
    try {
      const state = get();
      const newFiles = state.files.filter((file) => file.id !== id);
      await AsyncStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(newFiles));
      set({ files: newFiles });
    } catch (error) {
      console.error("Error deleting file:", error);
      throw error;
    }
  },

  getFilesByCategory: (category: FileCategory) => {
    return get().files.filter((file) => file.category === category);
  },

  searchFiles: (query: string) => {
    const lowerQuery = query.toLowerCase();
    return get().files.filter((file) =>
      file.name.toLowerCase().includes(lowerQuery) ||
      file.type.toLowerCase().includes(lowerQuery)
    );
  },
}));
