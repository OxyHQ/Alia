import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Project {
  id: string;
  name: string;
  description?: string;
  icon?: string; // Lucide icon name
  color?: string;
  conversationIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectsStoreState {
  projects: Project[];
  currentProjectId: string | null;
  loadProjects: () => Promise<void>;
  createProject: (name: string, description?: string, icon?: string) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setCurrentProject: (id: string | null) => void;
  addConversationToProject: (projectId: string, conversationId: string) => Promise<void>;
  removeConversationFromProject: (projectId: string, conversationId: string) => Promise<void>;
}

const PROJECTS_STORAGE_KEY = "alia-projects";
const CURRENT_PROJECT_KEY = "alia-current-project";

export const useProjectsStore = create<ProjectsStoreState>((set, get) => ({
  projects: [],
  currentProjectId: null,

  loadProjects: async () => {
    try {
      const [projectsData, currentProjectData] = await Promise.all([
        AsyncStorage.getItem(PROJECTS_STORAGE_KEY),
        AsyncStorage.getItem(CURRENT_PROJECT_KEY),
      ]);

      if (projectsData) {
        const parsed = JSON.parse(projectsData);
        const projects = parsed.map((proj: any) => ({
          ...proj,
          createdAt: new Date(proj.createdAt),
          updatedAt: new Date(proj.updatedAt),
        }));
        set({ projects });
      }

      if (currentProjectData) {
        set({ currentProjectId: currentProjectData });
      }
    } catch (error) {
      console.error("Error loading projects:", error);
    }
  },

  createProject: async (name: string, description?: string, icon?: string) => {
    try {
      const state = get();
      const project: Project = {
        id: `project-${Date.now()}`,
        name,
        description,
        icon: icon || getRandomIcon(),
        color: getRandomColor(),
        conversationIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const newProjects = [...state.projects, project];
      await AsyncStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(newProjects));
      set({ projects: newProjects });
    } catch (error) {
      console.error("Error creating project:", error);
    }
  },

  updateProject: async (id: string, updates: Partial<Project>) => {
    try {
      const state = get();
      const newProjects = state.projects.map((proj) =>
        proj.id === id
          ? { ...proj, ...updates, updatedAt: new Date() }
          : proj
      );
      await AsyncStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(newProjects));
      set({ projects: newProjects });
    } catch (error) {
      console.error("Error updating project:", error);
    }
  },

  deleteProject: async (id: string) => {
    try {
      const state = get();
      const newProjects = state.projects.filter((proj) => proj.id !== id);
      await AsyncStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(newProjects));

      // If we're deleting the current project, clear it
      if (state.currentProjectId === id) {
        await AsyncStorage.removeItem(CURRENT_PROJECT_KEY);
        set({ projects: newProjects, currentProjectId: null });
      } else {
        set({ projects: newProjects });
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

  addConversationToProject: async (projectId: string, conversationId: string) => {
    try {
      const state = get();
      const newProjects = state.projects.map((proj) => {
        if (proj.id === projectId && !proj.conversationIds.includes(conversationId)) {
          return {
            ...proj,
            conversationIds: [...proj.conversationIds, conversationId],
            updatedAt: new Date(),
          };
        }
        return proj;
      });
      await AsyncStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(newProjects));
      set({ projects: newProjects });
    } catch (error) {
      console.error("Error adding conversation to project:", error);
    }
  },

  removeConversationFromProject: async (projectId: string, conversationId: string) => {
    try {
      const state = get();
      const newProjects = state.projects.map((proj) => {
        if (proj.id === projectId) {
          return {
            ...proj,
            conversationIds: proj.conversationIds.filter((id) => id !== conversationId),
            updatedAt: new Date(),
          };
        }
        return proj;
      });
      await AsyncStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(newProjects));
      set({ projects: newProjects });
    } catch (error) {
      console.error("Error removing conversation from project:", error);
    }
  },
}));

// Helper function to generate random colors for projects
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

// Helper function to generate random icons for projects
function getRandomIcon(): string {
  const icons = [
    "FolderOpen",
    "Briefcase",
    "Folder",
    "Package",
    "Rocket",
    "Target",
    "Lightbulb",
    "Star",
    "Heart",
    "Zap",
  ];
  return icons[Math.floor(Math.random() * icons.length)];
}
