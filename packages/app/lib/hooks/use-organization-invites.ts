import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';

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
