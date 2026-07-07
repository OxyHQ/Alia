import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { useCredits } from './use-billing';
import apiClient from '@/lib/api/client';

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
  members?: Array<WorkspaceMember>;
  memberCount?: number;
  billing?: {
    plan: 'free' | 'pro' | 'enterprise';
    credits: number;
    creditsUsed: number;
    billingEmail?: string;
  };
}

// ======================
// SSR-safe storage
// ======================

const CURRENT_WORKSPACE_KEY = 'alia-current-workspace';

const storage = {
  get: (key: string): string | null =>
    typeof window !== 'undefined' ? localStorage.getItem(key) : null,
  set: (key: string, value: string) => {
    if (typeof window !== 'undefined') localStorage.setItem(key, value);
  },
};

// ======================
// API types & functions
// ======================

interface ApiOrganization {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  ownerId: string;
  role: WorkspaceRole;
  memberCount?: number;
  members?: Array<ApiMember>;
  credits?: { paid?: number };
  settings?: { billingEmail?: string; apiCallLimit?: number };
  createdAt: string;
  updatedAt: string;
}

interface ApiMember {
  _id: string;
  oxyUserId: string | { _id: string; email?: string; username?: string; name?: string; image?: string };
  role: WorkspaceRole;
  permissions: Array<string>;
  createdAt: string;
}

async function fetchOrganizations(): Promise<Array<ApiOrganization>> {
  const response = await apiClient.get('/organization');
  return response.data.organizations;
}

async function fetchMembers(orgId: string): Promise<Array<ApiMember>> {
  const response = await apiClient.get(`/organization/${orgId}/members`);
  return response.data.members;
}

// ======================
// Mappers
// ======================

function generateSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function mapMember(m: ApiMember): WorkspaceMember {
  const user = typeof m.oxyUserId === 'object' ? m.oxyUserId : null;
  return {
    id: m._id,
    email: user?.email || '',
    name: user?.username || user?.name,
    avatar: user?.image,
    role: m.role,
    joinedAt: m.createdAt,
  };
}

function mapOrg(org: ApiOrganization): Workspace {
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
    members: org.members?.map(mapMember),
    memberCount: org.memberCount,
    billing: {
      plan: 'free',
      credits: org.credits?.paid ?? 0,
      creditsUsed: 0,
      billingEmail: org.settings?.billingEmail,
    },
  };
}

// ======================
// Permission utilities
// ======================

export function getUserRole(userId: string, workspace: Workspace): WorkspaceRole | null {
  if (workspace.type === 'personal') return 'owner';
  return workspace.members?.find((m) => m.id === userId)?.role || null;
}

export function canEditWorkspace(userId: string, workspace: Workspace): boolean {
  const role = getUserRole(userId, workspace);
  return role === 'owner' || role === 'admin';
}

export function canManageMembers(userId: string, workspace: Workspace): boolean {
  if (workspace.type === 'personal') return false;
  const role = getUserRole(userId, workspace);
  return role === 'owner' || role === 'admin';
}

export function canDeleteWorkspace(userId: string, workspace: Workspace): boolean {
  if (workspace.id === 'personal') return false;
  return getUserRole(userId, workspace) === 'owner';
}

// ======================
// Hooks
// ======================

export function useCurrentWorkspaceId() {
  const [id, setIdState] = useState(() => storage.get(CURRENT_WORKSPACE_KEY) || 'personal');

  const setId = useCallback((newId: string) => {
    setIdState(newId);
    storage.set(CURRENT_WORKSPACE_KEY, newId);
  }, []);

  return [id, setId] as const;
}

export function useWorkspaces() {
  const { user, isAuthenticated, isReady } = useAuth();
  const { data: creditsData } = useCredits();

  const orgsQuery = useQuery({
    queryKey: ['organizations'],
    queryFn: fetchOrganizations,
    enabled: isReady && isAuthenticated,
    staleTime: 1000 * 60 * 5,
    retry: 2,
  });

  const userId = (user?._id as string) || (user?.id as string) || 'anonymous';

  const workspaces = useMemo((): Array<Workspace> => {
    if (!isAuthenticated || !user) return [];

    const personal: Workspace = {
      id: 'personal',
      name: 'Personal Account',
      slug: 'personal',
      type: 'personal',
      createdAt: new Date().toISOString(),
      ownerId: userId,
      members: [{
        id: userId,
        email: user.email || '',
        name: user.username || 'You',
        role: 'owner',
        joinedAt: new Date().toISOString(),
      }],
      billing: {
        plan: 'free',
        credits: creditsData?.credits ?? 300,
        creditsUsed: 0,
      },
    };

    return [personal, ...(orgsQuery.data || []).map(mapOrg)];
  }, [isAuthenticated, user, userId, orgsQuery.data, creditsData]);

  return {
    workspaces,
    isLoading: !isReady || (isAuthenticated && orgsQuery.isLoading),
    userId,
  };
}

export function useWorkspaceMembers(workspaceId: string) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['organization-members', workspaceId],
    queryFn: () => fetchMembers(workspaceId),
    enabled: isReady && isAuthenticated && !!workspaceId && workspaceId !== 'personal',
    staleTime: 1000 * 60 * 2,
    retry: 1,
    select: (data) => data.map(mapMember),
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const response = await apiClient.post('/organization', {
        name: data.name,
        slug: generateSlug(data.name),
        description: data.description,
      });
      return response.data.organization as ApiOrganization;
    },
    onSuccess: (newOrg) => {
      queryClient.setQueryData<Array<ApiOrganization>>(['organizations'], (old) => {
        if (!old) return [newOrg];
        return [newOrg, ...old];
      });
    },
  });
}

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; description?: string; image?: string } }) => {
      const response = await apiClient.patch(`/organization/${id}`, data);
      return response.data.organization as ApiOrganization;
    },
    onSuccess: (updatedOrg) => {
      queryClient.setQueryData<Array<ApiOrganization>>(['organizations'], (old) => {
        if (!old) return [updatedOrg];
        return old.map((org) => (org._id === updatedOrg._id ? updatedOrg : org));
      });
    },
  });
}

export function useUploadWorkspaceImage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, file }: { workspaceId: string; file: File }) => {
      const formData = new FormData();
      formData.append('file', file);
      const response = await apiClient.post(`/organization/${workspaceId}/image`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return response.data.image as string;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/organization/${id}`);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<Array<ApiOrganization>>(['organizations'], (old) => {
        if (!old) return [];
        return old.filter((org) => org._id !== id);
      });
      queryClient.removeQueries({ queryKey: ['organization-members', id] });
    },
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, email, role }: { workspaceId: string; email: string; role: WorkspaceRole }) => {
      const response = await apiClient.post(`/organization/${workspaceId}/members`, { email, role });
      return response.data;
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', workspaceId] });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, memberId }: { workspaceId: string; memberId: string }) => {
      await apiClient.delete(`/organization/${workspaceId}/members/${memberId}`);
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', workspaceId] });
    },
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, memberId, role }: { workspaceId: string; memberId: string; role: WorkspaceRole }) => {
      const response = await apiClient.patch(`/organization/${workspaceId}/members/${memberId}`, { role });
      return response.data.member;
    },
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', workspaceId] });
    },
  });
}
