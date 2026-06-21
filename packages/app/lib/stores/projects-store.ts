import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CollectionPersister, type CollectionItem } from "./create-collection-store";

export interface Project extends CollectionItem {
  description?: string;
}

const PROJECT_ICONS = [
  "FolderOpen", "Briefcase", "Folder", "Package", "Rocket",
  "Target", "Lightbulb", "Star", "Heart", "Zap",
];
const persister = new CollectionPersister<Project>("alia-projects", "project", PROJECT_ICONS);
const CURRENT_PROJECT_KEY = "alia-current-project";

interface ProjectsStoreState {
  projects: Project[];
  currentProjectId: string | null;
  loadProjects: () => Promise<void>;
  createProject: (name: string, description?: string, icon?: string) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setCurrentProject: (id: string | null) => void;
  toggleProject: (id: string) => Promise<void>;
  addConversationToProject: (projectId: string, conversationId: string) => Promise<void>;
  removeConversationFromProject: (projectId: string, conversationId: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStoreState>((set, get) => ({
  projects: [],
  currentProjectId: null,

  loadProjects: async () => {
    try {
      const [projects, currentProjectData] = await Promise.all([
        persister.load(),
        AsyncStorage.getItem(CURRENT_PROJECT_KEY),
      ]);
      set({ projects, currentProjectId: currentProjectData || null });
    } catch (error) {
      console.error("Error loading projects:", error);
    }
  },

  createProject: async (name: string, description?: string, icon?: string) => {
    try {
      const project = persister.newItem(name, { description, ...(icon && { icon }) } as Partial<Project>);
      const projects = [...get().projects, project];
      await persister.save(projects);
      set({ projects });
    } catch (error) {
      console.error("Error creating project:", error);
    }
  },

  updateProject: async (id: string, updates: Partial<Project>) => {
    try {
      const projects = persister.updateIn(get().projects, id, updates);
      await persister.save(projects);
      set({ projects });
    } catch (error) {
      console.error("Error updating project:", error);
    }
  },

  deleteProject: async (id: string) => {
    try {
      const state = get();
      const projects = state.projects.filter((p) => p.id !== id);
      await persister.save(projects);

      if (state.currentProjectId === id) {
        await AsyncStorage.removeItem(CURRENT_PROJECT_KEY);
        set({ projects, currentProjectId: null });
      } else {
        set({ projects });
      }
    } catch (error) {
      console.error("Error deleting project:", error);
    }
  },

  setCurrentProject: async (id: string | null) => {
    try {
      if (id) {
        await AsyncStorage.setItem(CURRENT_PROJECT_KEY, id);
      } else {
        await AsyncStorage.removeItem(CURRENT_PROJECT_KEY);
      }
      set({ currentProjectId: id });
    } catch (error) {
      console.error("Error setting current project:", error);
    }
  },

  toggleProject: async (id: string) => {
    try {
      const projects = get().projects.map((p) =>
        p.id === id ? { ...p, isExpanded: !p.isExpanded } : p
      );
      await persister.save(projects);
      set({ projects });
    } catch (error) {
      console.error("Error toggling project:", error);
    }
  },

  addConversationToProject: async (projectId: string, conversationId: string) => {
    try {
      const projects = persister.addConversation(get().projects, projectId, conversationId);
      await persister.save(projects);
      set({ projects });
    } catch (error) {
      console.error("Error adding conversation to project:", error);
    }
  },

  removeConversationFromProject: async (projectId: string, conversationId: string) => {
    try {
      const projects = persister.removeConversation(get().projects, projectId, conversationId);
      await persister.save(projects);
      set({ projects });
    } catch (error) {
      console.error("Error removing conversation from project:", error);
    }
  },
}));
