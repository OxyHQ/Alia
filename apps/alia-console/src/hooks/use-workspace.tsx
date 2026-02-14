import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import apiClient from '@/lib/api/client';
import { useCredits } from './use-billing';

// ======================
// Types
// ======================

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface WorkspaceMember {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  role: WorkspaceRole;
  joinedAt: string;
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
  memberCount?: number;
  billing?: WorkspaceBilling;
  settings?: {
    defaultRole: WorkspaceRole;
    allowMemberInvites: boolean;
    requireApproval: boolean;
  };
}

export interface CreateWorkspaceData {
  name: string;
  description?: string;
}

export interface UpdateWorkspaceData {
  name?: string;
  description?: string;
  icon?: string;
}

interface WorkspaceContextValue {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  isLoading: boolean;

  setCurrentWorkspace: (workspace: Workspace) => void;
  createWorkspace: (data: CreateWorkspaceData) => Promise<Workspace>;
  updateWorkspace: (id: string, data: UpdateWorkspaceData) => Promise<Workspace | null>;
  deleteWorkspace: (id: string) => Promise<boolean>;

  inviteMember: (workspaceId: string, email: string, role: WorkspaceRole) => Promise<any>;
  removeMember: (workspaceId: string, memberId: string) => Promise<boolean>;
  updateMemberRole: (workspaceId: string, memberId: string, role: WorkspaceRole) => Promise<boolean>;

  canEditWorkspace: (workspace: Workspace) => boolean;
  canManageMembers: (workspace: Workspace) => boolean;
  canDeleteWorkspace: (workspace: Workspace) => boolean;
  getUserRole: (workspace: Workspace) => WorkspaceRole | null;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

const CURRENT_WORKSPACE_KEY = 'alia-current-workspace';

// ======================
// API Functions
// ======================

interface ApiOrganization {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  ownerId: string;
  credits: { paid: number };
  settings: { billingEmail?: string; apiCallLimit?: number };
  role: WorkspaceRole;
  memberCount?: number;
  members?: ApiMember[];
  createdAt: string;
  updatedAt: string;
}

interface ApiMember {
  _id: string;
  oxyUserId: string | { _id: string; email?: string; username?: string; name?: string; image?: string };
  role: WorkspaceRole;
  permissions: string[];
  createdAt: string;
}

async function fetchOrganizations(): Promise<ApiOrganization[]> {
  const response = await apiClient.get('/organization');
  return response.data.organizations;
}

async function createOrganization(data: { name: string; slug: string; description?: string }): Promise<ApiOrganization> {
  const response = await apiClient.post('/organization', data);
  return response.data.organization;
}

async function updateOrganization(id: string, data: Partial<{ name: string; description: string; image: string }>): Promise<ApiOrganization> {
  const response = await apiClient.patch(`/organization/${id}`, data);
  return response.data.organization;
}

async function deleteOrganization(id: string): Promise<void> {
  await apiClient.delete(`/organization/${id}`);
}

async function fetchMembers(orgId: string): Promise<ApiMember[]> {
  const response = await apiClient.get(`/organization/${orgId}/members`);
  return response.data.members;
}

async function inviteMemberApi(orgId: string, email: string, role: string): Promise<any> {
  const response = await apiClient.post(`/organization/${orgId}/members`, { email, role });
  return response.data;
}

async function updateMemberRoleApi(orgId: string, memberId: string, role: string): Promise<any> {
  const response = await apiClient.patch(`/organization/${orgId}/members/${memberId}`, { role });
  return response.data.member;
}

async function removeMemberApi(orgId: string, memberId: string): Promise<void> {
  await apiClient.delete(`/organization/${orgId}/members/${memberId}`);
}

// ======================
// Mappers
// ======================

function generateSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function mapMemberToWorkspaceMember(member: ApiMember): WorkspaceMember {
  const user = typeof member.oxyUserId === 'object' ? member.oxyUserId : null;
  return {
    id: member._id,
    email: user?.email || '',
    name: user?.username || user?.name,
    avatar: user?.image,
    role: member.role,
    joinedAt: member.createdAt,
  };
}

function mapOrgToWorkspace(org: ApiOrganization): Workspace {
  return {
    id: org._id,
    name: org.name,
    slug: org.slug,
    description: org.description,
    type: 'team',
    icon: org.image,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    ownerId: org.ownerId,
    members: org.members?.map(mapMemberToWorkspaceMember),
    memberCount: org.memberCount,
    billing: {
      plan: 'free',
      credits: org.credits?.paid || 0,
      creditsUsed: 0,
      billingEmail: org.settings?.billingEmail,
    },
    settings: {
      defaultRole: 'member',
      allowMemberInvites: true,
      requireApproval: false,
    },
  };
}

// ======================
// Provider
// ======================

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isReady } = useAuth();
  const queryClient = useQueryClient();
  const userId = (user?._id as string) || (user?.id as string) || 'anonymous';

  const [currentWorkspaceId, setCurrentWorkspaceId] = React.useState<string>(
    () => localStorage.getItem(CURRENT_WORKSPACE_KEY) || 'personal'
  );

  // Fetch team workspaces (organizations) from API
  const orgsQuery = useQuery({
    queryKey: ['organizations'],
    queryFn: fetchOrganizations,
    enabled: isReady && isAuthenticated,
    staleTime: 1000 * 60 * 5,
  });

  // Fetch user credits for personal workspace billing
  const { data: creditsData } = useCredits();

  // Build combined workspace list
  const workspaces = React.useMemo(() => {
    if (!isAuthenticated || !user) return [];

    const personal: Workspace = {
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
        credits: creditsData?.credits ?? 300,
        creditsUsed: 0,
      },
      settings: {
        defaultRole: 'member',
        allowMemberInvites: false,
        requireApproval: false,
      },
    };

    const teamWorkspaces = (orgsQuery.data || []).map(mapOrgToWorkspace);
    return [personal, ...teamWorkspaces];
  }, [isAuthenticated, user, userId, orgsQuery.data, creditsData]);

  // Derive current workspace from ID
  const currentWorkspace = React.useMemo(() => {
    return workspaces.find((w) => w.id === currentWorkspaceId) || workspaces[0] || null;
  }, [workspaces, currentWorkspaceId]);

  const isLoading = !isReady || (isAuthenticated && orgsQuery.isLoading);

  // Set current workspace
  const setCurrentWorkspace = React.useCallback((workspace: Workspace) => {
    setCurrentWorkspaceId(workspace.id);
    localStorage.setItem(CURRENT_WORKSPACE_KEY, workspace.id);
  }, []);

  // Create workspace
  const createMutation = useMutation({
    mutationFn: (data: CreateWorkspaceData) =>
      createOrganization({
        name: data.name,
        slug: generateSlug(data.name),
        description: data.description,
      }),
    onSuccess: (newOrg) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setCurrentWorkspaceId(newOrg._id);
      localStorage.setItem(CURRENT_WORKSPACE_KEY, newOrg._id);
    },
  });

  const createWorkspaceAsync = React.useCallback(
    async (data: CreateWorkspaceData): Promise<Workspace> => {
      const org = await createMutation.mutateAsync(data);
      return mapOrgToWorkspace(org);
    },
    [createMutation]
  );

  // Update workspace
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateWorkspaceData }) =>
      updateOrganization(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });

  const updateWorkspaceAsync = React.useCallback(
    async (id: string, data: UpdateWorkspaceData): Promise<Workspace | null> => {
      const org = await updateMutation.mutateAsync({ id, data });
      return mapOrgToWorkspace(org);
    },
    [updateMutation]
  );

  // Delete workspace
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteOrganization(id),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      if (currentWorkspaceId === deletedId) {
        setCurrentWorkspaceId('personal');
        localStorage.setItem(CURRENT_WORKSPACE_KEY, 'personal');
      }
    },
  });

  const deleteWorkspaceAsync = React.useCallback(
    async (id: string): Promise<boolean> => {
      if (id === 'personal') return false;
      await deleteMutation.mutateAsync(id);
      return true;
    },
    [deleteMutation]
  );

  // Invite member
  const inviteMutation = useMutation({
    mutationFn: ({ orgId, email, role }: { orgId: string; email: string; role: string }) =>
      inviteMemberApi(orgId, email, role),
    onSuccess: (_, { orgId }) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', orgId] });
    },
  });

  const inviteMemberAsync = React.useCallback(
    async (workspaceId: string, email: string, role: WorkspaceRole) => {
      return inviteMutation.mutateAsync({ orgId: workspaceId, email, role });
    },
    [inviteMutation]
  );

  // Remove member
  const removeMemberMutation = useMutation({
    mutationFn: ({ orgId, memberId }: { orgId: string; memberId: string }) =>
      removeMemberApi(orgId, memberId),
    onSuccess: (_, { orgId }) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', orgId] });
    },
  });

  const removeMemberAsync = React.useCallback(
    async (workspaceId: string, memberId: string): Promise<boolean> => {
      await removeMemberMutation.mutateAsync({ orgId: workspaceId, memberId });
      return true;
    },
    [removeMemberMutation]
  );

  // Update member role
  const updateRoleMutation = useMutation({
    mutationFn: ({ orgId, memberId, role }: { orgId: string; memberId: string; role: string }) =>
      updateMemberRoleApi(orgId, memberId, role),
    onSuccess: (_, { orgId }) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', orgId] });
    },
  });

  const updateMemberRoleAsync = React.useCallback(
    async (workspaceId: string, memberId: string, role: WorkspaceRole): Promise<boolean> => {
      await updateRoleMutation.mutateAsync({ orgId: workspaceId, memberId, role });
      return true;
    },
    [updateRoleMutation]
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
      createWorkspace: createWorkspaceAsync,
      updateWorkspace: updateWorkspaceAsync,
      deleteWorkspace: deleteWorkspaceAsync,
      inviteMember: inviteMemberAsync,
      removeMember: removeMemberAsync,
      updateMemberRole: updateMemberRoleAsync,
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
      createWorkspaceAsync,
      updateWorkspaceAsync,
      deleteWorkspaceAsync,
      inviteMemberAsync,
      removeMemberAsync,
      updateMemberRoleAsync,
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

// ======================
// Lazy members hook
// ======================

export function useWorkspaceMembers(workspaceId: string) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['organization-members', workspaceId],
    queryFn: () => fetchMembers(workspaceId),
    enabled: isReady && isAuthenticated && !!workspaceId && workspaceId !== 'personal',
    staleTime: 1000 * 60 * 2,
    select: (data) => data.map(mapMemberToWorkspaceMember),
  });
}
