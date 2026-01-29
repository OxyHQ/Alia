import * as React from 'react';
import { useAuth } from '@oxyhq/services/web';

export interface Workspace {
  id: string;
  name: string;
  type: 'personal' | 'team';
  icon?: string;
  createdAt: string;
}

interface WorkspaceContextValue {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  setCurrentWorkspace: (workspace: Workspace) => void;
  createWorkspace: (name: string) => Workspace;
  isLoading: boolean;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

const STORAGE_KEY = 'alia-workspaces';
const CURRENT_WORKSPACE_KEY = 'alia-current-workspace';

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isReady } = useAuth();
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspaceState] = React.useState<Workspace | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  // Initialize workspaces from localStorage and create personal workspace
  React.useEffect(() => {
    if (!isReady) return;

    const initWorkspaces = () => {
      // Get stored workspaces
      const stored = localStorage.getItem(STORAGE_KEY);
      let storedWorkspaces: Workspace[] = stored ? JSON.parse(stored) : [];

      // Create personal workspace if authenticated
      if (isAuthenticated && user) {
        const personalWorkspace: Workspace = {
          id: 'personal',
          name: 'Personal Account',
          type: 'personal',
          createdAt: new Date().toISOString(),
        };

        // Ensure personal workspace exists
        const hasPersonal = storedWorkspaces.some((w) => w.id === 'personal');
        if (!hasPersonal) {
          storedWorkspaces = [personalWorkspace, ...storedWorkspaces];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(storedWorkspaces));
        }

        setWorkspaces(storedWorkspaces);

        // Set current workspace
        const currentId = localStorage.getItem(CURRENT_WORKSPACE_KEY);
        const current = storedWorkspaces.find((w) => w.id === currentId) || personalWorkspace;
        setCurrentWorkspaceState(current);
      } else {
        setWorkspaces([]);
        setCurrentWorkspaceState(null);
      }

      setIsLoading(false);
    };

    initWorkspaces();
  }, [isReady, isAuthenticated, user]);

  const setCurrentWorkspace = React.useCallback((workspace: Workspace) => {
    setCurrentWorkspaceState(workspace);
    localStorage.setItem(CURRENT_WORKSPACE_KEY, workspace.id);
  }, []);

  const createWorkspace = React.useCallback(
    (name: string): Workspace => {
      const newWorkspace: Workspace = {
        id: `workspace-${Date.now()}`,
        name,
        type: 'team',
        createdAt: new Date().toISOString(),
      };

      const updatedWorkspaces = [...workspaces, newWorkspace];
      setWorkspaces(updatedWorkspaces);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedWorkspaces));

      // Switch to new workspace
      setCurrentWorkspace(newWorkspace);

      return newWorkspace;
    },
    [workspaces, setCurrentWorkspace]
  );

  const value = React.useMemo(
    () => ({
      workspaces,
      currentWorkspace,
      setCurrentWorkspace,
      createWorkspace,
      isLoading,
    }),
    [workspaces, currentWorkspace, setCurrentWorkspace, createWorkspace, isLoading]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = React.useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within WorkspaceProvider');
  }
  return context;
}
