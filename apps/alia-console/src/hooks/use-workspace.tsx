import * as React from 'react';
import { useAuth } from '@oxyhq/services/web';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface WorkspaceMember {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  role: WorkspaceRole;
  joinedAt: string;
  invitedBy?: string;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedAt: string;
  invitedBy: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'expired';
}

export interface WorkspaceBilling {
  plan: 'free' | 'pro' | 'enterprise';
  credits: number;
  creditsUsed: number;
  billingEmail?: string;
  nextBillingDate?: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  type: 'personal' | 'team';
  icon?: string;
  createdAt: string;
  updatedAt?: string;
  ownerId?: string;
  members?: WorkspaceMember[];
  invites?: WorkspaceInvite[];
  billing?: WorkspaceBilling;
  settings?: {
    defaultRole: WorkspaceRole;
    allowMemberInvites: boolean;
    requireApproval: boolean;
  };
}

interface WorkspaceContextValue {
  // State
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  isLoading: boolean;

  // Workspace CRUD
  setCurrentWorkspace: (workspace: Workspace) => void;
  createWorkspace: (data: CreateWorkspaceData) => Workspace;
  updateWorkspace: (id: string, data: UpdateWorkspaceData) => Workspace | null;
  deleteWorkspace: (id: string) => boolean;

  // Team Management
  inviteMember: (workspaceId: string, email: string, role: WorkspaceRole) => WorkspaceInvite | null;
  removeMember: (workspaceId: string, memberId: string) => boolean;
  updateMemberRole: (workspaceId: string, memberId: string, role: WorkspaceRole) => boolean;
  cancelInvite: (workspaceId: string, inviteId: string) => boolean;

  // Permissions
  canEditWorkspace: (workspace: Workspace) => boolean;
  canManageMembers: (workspace: Workspace) => boolean;
  canDeleteWorkspace: (workspace: Workspace) => boolean;
  getUserRole: (workspace: Workspace) => WorkspaceRole | null;
}

export interface CreateWorkspaceData {
  name: string;
  description?: string;
  type?: 'personal' | 'team';
}

export interface UpdateWorkspaceData {
  name?: string;
  description?: string;
  icon?: string;
  settings?: Workspace['settings'];
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

const STORAGE_KEY = 'alia-workspaces';
const CURRENT_WORKSPACE_KEY = 'alia-current-workspace';

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isReady } = useAuth();
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspaceState] = React.useState<Workspace | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  const userId = (user?._id as string) || (user?.id as string) || 'anonymous';

  // Persist workspaces to localStorage
  const persistWorkspaces = React.useCallback((updated: Workspace[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, []);

  // Initialize workspaces from localStorage
  React.useEffect(() => {
    if (!isReady) return;

    const initWorkspaces = () => {
      const stored = localStorage.getItem(STORAGE_KEY);
      let storedWorkspaces: Workspace[] = stored ? JSON.parse(stored) : [];

      if (isAuthenticated && user) {
        // Create personal workspace if it doesn't exist
        const personalWorkspace: Workspace = {
          id: 'personal',
          name: 'Personal Account',
          slug: 'personal',
          type: 'personal',
          createdAt: new Date().toISOString(),
          ownerId: userId,
          members: [
            {
              id: userId,
              email: user.email || '',
              name: user.username || 'You',
              role: 'owner',
              joinedAt: new Date().toISOString(),
            },
          ],
          billing: {
            plan: 'free',
            credits: 300,
            creditsUsed: 0,
          },
          settings: {
            defaultRole: 'member',
            allowMemberInvites: false,
            requireApproval: false,
          },
        };

        const hasPersonal = storedWorkspaces.some((w) => w.id === 'personal');
        if (!hasPersonal) {
          storedWorkspaces = [personalWorkspace, ...storedWorkspaces];
          persistWorkspaces(storedWorkspaces);
        } else {
          // Update personal workspace owner if needed
          storedWorkspaces = storedWorkspaces.map((w) =>
            w.id === 'personal' ? { ...w, ownerId: userId } : w
          );
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
  }, [isReady, isAuthenticated, user, userId, persistWorkspaces]);

  // Set current workspace
  const setCurrentWorkspace = React.useCallback((workspace: Workspace) => {
    setCurrentWorkspaceState(workspace);
    localStorage.setItem(CURRENT_WORKSPACE_KEY, workspace.id);
  }, []);

  // Create workspace
  const createWorkspace = React.useCallback(
    (data: CreateWorkspaceData): Workspace => {
      const newWorkspace: Workspace = {
        id: `workspace-${generateId()}`,
        name: data.name,
        slug: generateSlug(data.name),
        description: data.description,
        type: data.type || 'team',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ownerId: userId,
        members: [
          {
            id: userId,
            email: user?.email || '',
            name: user?.username || 'You',
            role: 'owner',
            joinedAt: new Date().toISOString(),
          },
        ],
        invites: [],
        billing: {
          plan: 'free',
          credits: 0,
          creditsUsed: 0,
        },
        settings: {
          defaultRole: 'member',
          allowMemberInvites: true,
          requireApproval: false,
        },
      };

      const updatedWorkspaces = [...workspaces, newWorkspace];
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);
      setCurrentWorkspace(newWorkspace);

      return newWorkspace;
    },
    [workspaces, userId, user, persistWorkspaces, setCurrentWorkspace]
  );

  // Update workspace
  const updateWorkspace = React.useCallback(
    (id: string, data: UpdateWorkspaceData): Workspace | null => {
      const workspace = workspaces.find((w) => w.id === id);
      if (!workspace) return null;

      const updatedWorkspace: Workspace = {
        ...workspace,
        ...data,
        slug: data.name ? generateSlug(data.name) : workspace.slug,
        updatedAt: new Date().toISOString(),
        settings: data.settings ? { ...workspace.settings, ...data.settings } : workspace.settings,
      };

      const updatedWorkspaces = workspaces.map((w) => (w.id === id ? updatedWorkspace : w));
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);

      // Update current workspace if it's the one being edited
      if (currentWorkspace?.id === id) {
        setCurrentWorkspaceState(updatedWorkspace);
      }

      return updatedWorkspace;
    },
    [workspaces, currentWorkspace, persistWorkspaces]
  );

  // Delete workspace
  const deleteWorkspace = React.useCallback(
    (id: string): boolean => {
      if (id === 'personal') return false; // Can't delete personal workspace

      const updatedWorkspaces = workspaces.filter((w) => w.id !== id);
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);

      // Switch to personal if deleting current workspace
      if (currentWorkspace?.id === id) {
        const personal = updatedWorkspaces.find((w) => w.id === 'personal');
        if (personal) {
          setCurrentWorkspace(personal);
        }
      }

      return true;
    },
    [workspaces, currentWorkspace, persistWorkspaces, setCurrentWorkspace]
  );

  // Invite member
  const inviteMember = React.useCallback(
    (workspaceId: string, email: string, role: WorkspaceRole): WorkspaceInvite | null => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return null;

      const invite: WorkspaceInvite = {
        id: `invite-${generateId()}`,
        email,
        role,
        invitedAt: new Date().toISOString(),
        invitedBy: userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        status: 'pending',
      };

      const updatedWorkspace: Workspace = {
        ...workspace,
        invites: [...(workspace.invites || []), invite],
        updatedAt: new Date().toISOString(),
      };

      const updatedWorkspaces = workspaces.map((w) => (w.id === workspaceId ? updatedWorkspace : w));
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);

      if (currentWorkspace?.id === workspaceId) {
        setCurrentWorkspaceState(updatedWorkspace);
      }

      return invite;
    },
    [workspaces, userId, currentWorkspace, persistWorkspaces]
  );

  // Remove member
  const removeMember = React.useCallback(
    (workspaceId: string, memberId: string): boolean => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace || !workspace.members) return false;

      // Can't remove owner
      const member = workspace.members.find((m) => m.id === memberId);
      if (member?.role === 'owner') return false;

      const updatedWorkspace: Workspace = {
        ...workspace,
        members: workspace.members.filter((m) => m.id !== memberId),
        updatedAt: new Date().toISOString(),
      };

      const updatedWorkspaces = workspaces.map((w) => (w.id === workspaceId ? updatedWorkspace : w));
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);

      if (currentWorkspace?.id === workspaceId) {
        setCurrentWorkspaceState(updatedWorkspace);
      }

      return true;
    },
    [workspaces, currentWorkspace, persistWorkspaces]
  );

  // Update member role
  const updateMemberRole = React.useCallback(
    (workspaceId: string, memberId: string, role: WorkspaceRole): boolean => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace || !workspace.members) return false;

      // Can't change owner's role
      const member = workspace.members.find((m) => m.id === memberId);
      if (member?.role === 'owner') return false;

      const updatedWorkspace: Workspace = {
        ...workspace,
        members: workspace.members.map((m) => (m.id === memberId ? { ...m, role } : m)),
        updatedAt: new Date().toISOString(),
      };

      const updatedWorkspaces = workspaces.map((w) => (w.id === workspaceId ? updatedWorkspace : w));
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);

      if (currentWorkspace?.id === workspaceId) {
        setCurrentWorkspaceState(updatedWorkspace);
      }

      return true;
    },
    [workspaces, currentWorkspace, persistWorkspaces]
  );

  // Cancel invite
  const cancelInvite = React.useCallback(
    (workspaceId: string, inviteId: string): boolean => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace || !workspace.invites) return false;

      const updatedWorkspace: Workspace = {
        ...workspace,
        invites: workspace.invites.filter((i) => i.id !== inviteId),
        updatedAt: new Date().toISOString(),
      };

      const updatedWorkspaces = workspaces.map((w) => (w.id === workspaceId ? updatedWorkspace : w));
      setWorkspaces(updatedWorkspaces);
      persistWorkspaces(updatedWorkspaces);

      if (currentWorkspace?.id === workspaceId) {
        setCurrentWorkspaceState(updatedWorkspace);
      }

      return true;
    },
    [workspaces, currentWorkspace, persistWorkspaces]
  );

  // Permission helpers
  const getUserRole = React.useCallback(
    (workspace: Workspace): WorkspaceRole | null => {
      if (workspace.type === 'personal') return 'owner';
      const member = workspace.members?.find((m) => m.id === userId);
      return member?.role || null;
    },
    [userId]
  );

  const canEditWorkspace = React.useCallback(
    (workspace: Workspace): boolean => {
      const role = getUserRole(workspace);
      return role === 'owner' || role === 'admin';
    },
    [getUserRole]
  );

  const canManageMembers = React.useCallback(
    (workspace: Workspace): boolean => {
      if (workspace.type === 'personal') return false;
      const role = getUserRole(workspace);
      return role === 'owner' || role === 'admin';
    },
    [getUserRole]
  );

  const canDeleteWorkspace = React.useCallback(
    (workspace: Workspace): boolean => {
      if (workspace.id === 'personal') return false;
      return getUserRole(workspace) === 'owner';
    },
    [getUserRole]
  );

  const value = React.useMemo(
    () => ({
      workspaces,
      currentWorkspace,
      isLoading,
      setCurrentWorkspace,
      createWorkspace,
      updateWorkspace,
      deleteWorkspace,
      inviteMember,
      removeMember,
      updateMemberRole,
      cancelInvite,
      canEditWorkspace,
      canManageMembers,
      canDeleteWorkspace,
      getUserRole,
    }),
    [
      workspaces,
      currentWorkspace,
      isLoading,
      setCurrentWorkspace,
      createWorkspace,
      updateWorkspace,
      deleteWorkspace,
      inviteMember,
      removeMember,
      updateMemberRole,
      cancelInvite,
      canEditWorkspace,
      canManageMembers,
      canDeleteWorkspace,
      getUserRole,
    ]
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
