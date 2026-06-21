import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';

export interface OrganizationInvite {
  _id: string;
  role: 'admin' | 'member';
  status: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteInfo {
  invite: {
    role: string;
    expiresAt: string;
    organization: {
      _id: string;
      name: string;
      slug: string;
      image?: string;
    };
  };
}

export function useCreateOrgInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, role }: { orgId: string; role: 'admin' | 'member' }) => {
      const response = await apiClient.post(`/organization/${orgId}/members`, { role });
      return response.data.invite as OrganizationInvite;
    },
    onSuccess: (_, { orgId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.invites(orgId) });
    },
  });
}

export function useOrgInvites(orgId: string) {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.organizations.invites(orgId),
    queryFn: async () => {
      const response = await apiClient.get(`/organization/${orgId}/invites`);
      return response.data.invites;
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 1000 * 60 * 2,
  });
}

export function useRevokeOrgInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, inviteId }: { orgId: string; inviteId: string }) => {
      await apiClient.delete(`/organization/${orgId}/invites/${inviteId}`);
    },
    onSuccess: (_, { orgId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.invites(orgId) });
    },
  });
}

export function useOrgInviteInfo(token: string) {
  return useQuery<InviteInfo>({
    queryKey: ['org-invite-info', token],
    queryFn: async () => {
      const response = await apiClient.get(`/organization/invites/${token}/info`);
      return response.data;
    },
    enabled: !!token,
    retry: 1,
  });
}

export function useAcceptOrgInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (token: string) => {
      const response = await apiClient.post(`/organization/invites/${token}/accept`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
    },
  });
}
