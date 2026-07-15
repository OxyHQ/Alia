import { create } from "zustand";
import { Platform } from "react-native";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";

export type FileCategory = "documents" | "images" | "other";

export interface LibraryFile {
  _id: string;
  name: string;
  url: string;
  type: string;
  size: number;
  category: FileCategory;
  thumbnail?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface LibraryStoreState {
  files: LibraryFile[];
  loading: boolean;
  loadFiles: (category?: FileCategory) => Promise<void>;
  addFile: (file: { name: string; uri: string; type: string; size: number }) => Promise<LibraryFile | null>;
  deleteFile: (id: string) => Promise<void>;
  getFilesByCategory: (category: FileCategory) => LibraryFile[];
  searchFiles: (query: string) => LibraryFile[];
}

export const useLibraryStore = create<LibraryStoreState>((set, get) => ({
  files: [],
  loading: false,

  loadFiles: async (category?: FileCategory) => {
    try {
      set({ loading: true });
      const params: any = {};
      if (category) params.category = category;

      const res = await apiClient.get(API_ROUTES.library.list, { params });
      const files = res.data.files.map((f: any) => ({
        ...f,
        createdAt: new Date(f.createdAt),
        updatedAt: new Date(f.updatedAt),
      }));
      set({ files, loading: false });
    } catch (error) {
      console.error("Error loading library files:", error);
      set({ loading: false });
    }
  },

  addFile: async (fileData) => {
    try {
      const formData = new FormData();

      if (Platform.OS === "web") {
        const response = await fetch(fileData.uri);
        const blob = await response.blob();
        formData.append("file", blob, fileData.name);
      } else {
        // React Native's FormData accepts a `{ uri, name, type }` file part at
        // runtime, but the DOM `FormData` lib types only model `string | Blob`.
        formData.append("file", {
          uri: fileData.uri,
          name: fileData.name,
          type: fileData.type,
        } as unknown as Blob);
      }

      const res = await apiClient.post(API_ROUTES.library.upload, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      const file: LibraryFile = {
        ...res.data.file,
        createdAt: new Date(res.data.file.createdAt),
        updatedAt: new Date(res.data.file.updatedAt),
      };

      set((state) => ({ files: [file, ...state.files] }));
      return file;
    } catch (error) {
      console.error("Error uploading file:", error);
      throw error;
    }
  },

  deleteFile: async (id: string) => {
    try {
      await apiClient.delete(API_ROUTES.library.delete(id));
      set((state) => ({
        files: state.files.filter((file) => file._id !== id),
      }));
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
    return get().files.filter(
      (file) =>
        file.name.toLowerCase().includes(lowerQuery) ||
        file.type.toLowerCase().includes(lowerQuery)
    );
  },
}));
