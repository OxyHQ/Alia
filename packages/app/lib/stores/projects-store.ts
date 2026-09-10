import { create } from "zustand";
import { AccountScopedKey } from "./account-scope";
import { CollectionPersister, type CollectionItem } from "./create-collection-store";

export interface Project extends CollectionItem {
  description?: string;
}

const PROJECT_ICONS = [
  "FolderOpen", "Briefcase", "Folder", "Package", "Rocket",
  "Target", "Lightbulb", "Star", "Heart", "Zap",
];
const persister = new CollectionPersister<Project>("alia-projects", "project", PROJECT_ICONS);
// The selected project is one of the account's projects, so it is scoped the
// same way and bound together with the list.
const currentProjectKey = new AccountScopedKey("alia-current-project");

interface ProjectsStoreState {
  projects: Project[];
  currentProjectId: string | null;
  /**
   * Bind the store to the signed-in account and load its projects. `null`
   * (signed out) empties the list and reads nothing. The layout calls this
   * whenever the user id changes; see `AccountScopedKey` for the namespace,
   * the one-time legacy migration and the stale-load guard.
   */
  loadProjects: (userId: string | null) => Promise<void>;
  createProject: (name: string, description?: string, icon?: string) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setCurrentProject: (id: string | null) => void;
  toggleProject: (id: string) => Promise<void>;
  addConversationToProject: (projectId: string, conversationId: string) => Promise<void>;
  removeConversationFromProject: (projectId: string, conversationId: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStoreState>((set, get) => {
  // Persist, then publish — unless the account changed while the write was in
  // flight, in which case the list belongs to the previous account and must
  // not appear under the new one.
  const commit = async (projects: Project[], rest: Partial<ProjectsStoreState> = {}) => {
    const token = persister.storage.token;
    await persister.save(projects);
    if (persister.storage.isCurrent(token)) set({ projects, ...rest });
  };

  return {
    projects: [],
    currentProjectId: null,

    loadProjects: async (userId) => {
      // Empty synchronously: the previous account's projects must not stay on
      // screen for the duration of the read, and a signed-out state has none.
      const token = persister.storage.bind(userId);
      currentProjectKey.bind(userId);
      set({ projects: [], currentProjectId: null });
      if (!userId) return;
      try {
        const [projects, currentProjectData] = await Promise.all([
          persister.load(),
          currentProjectKey.getItem(),
        ]);
        if (!persister.storage.isCurrent(token)) return;
        set({ projects, currentProjectId: currentProjectData || null });
      } catch (error) {
        console.error("Error loading projects:", error);
      }
    },

    createProject: async (name: string, description?: string, icon?: string) => {
      try {
        const project = persister.newItem(name, { description, ...(icon && { icon }) } as Partial<Project>);
        await commit([...get().projects, project]);
      } catch (error) {
        console.error("Error creating project:", error);
      }
    },

    updateProject: async (id: string, updates: Partial<Project>) => {
      try {
        await commit(persister.updateIn(get().projects, id, updates));
      } catch (error) {
        console.error("Error updating project:", error);
      }
    },

    deleteProject: async (id: string) => {
      try {
        const state = get();
        const projects = state.projects.filter((p) => p.id !== id);

        if (state.currentProjectId === id) {
          await currentProjectKey.removeItem();
          await commit(projects, { currentProjectId: null });
        } else {
          await commit(projects);
        }
      } catch (error) {
        console.error("Error deleting project:", error);
      }
    },

    setCurrentProject: async (id: string | null) => {
      try {
        const token = currentProjectKey.token;
        if (id) {
          await currentProjectKey.setItem(id);
        } else {
          await currentProjectKey.removeItem();
        }
        if (currentProjectKey.isCurrent(token)) set({ currentProjectId: id });
      } catch (error) {
        console.error("Error setting current project:", error);
      }
    },

    toggleProject: async (id: string) => {
      try {
        await commit(get().projects.map((p) =>
          p.id === id ? { ...p, isExpanded: !p.isExpanded } : p
        ));
      } catch (error) {
        console.error("Error toggling project:", error);
      }
    },

    addConversationToProject: async (projectId: string, conversationId: string) => {
      try {
        await commit(persister.addConversation(get().projects, projectId, conversationId));
      } catch (error) {
        console.error("Error adding conversation to project:", error);
      }
    },

    removeConversationFromProject: async (projectId: string, conversationId: string) => {
      try {
        await commit(persister.removeConversation(get().projects, projectId, conversationId));
      } catch (error) {
        console.error("Error removing conversation from project:", error);
      }
    },
  };
});
