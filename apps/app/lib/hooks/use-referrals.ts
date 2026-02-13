import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

export interface ReferralInfo {
  inviteCode: string;
  inviteUrl: string;
  totalCreditsEarned: number;
  totalReferrals: number;
}

export interface ReferredUser {
  userId: string;
  email?: string;
  creditedAt: string;
  creditsAwarded: number;
}

export interface ReferralHistory {
  referrals: ReferredUser[];
  total: number;
}

async function fetchReferralInfo(): Promise<ReferralInfo> {
  const response = await apiClient.get('/referrals');
  return response.data;
}

async function fetchReferralHistory(): Promise<ReferralHistory> {
  const response = await apiClient.get('/referrals/history');
  return response.data;
}

export function useReferralInfo() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['referral-info'],
    queryFn: fetchReferralInfo,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

export function useReferralHistory() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['referral-history'],
    queryFn: fetchReferralHistory,
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
    enabled: isAuthenticated,
  });
}

export function useSendInviteEmail() {
  return useMutation({
    mutationFn: async (email: string) => {
      const response = await apiClient.post('/referrals/send-invite', { email });
      return response.data as { success: boolean; inviteUrl: string; mailtoUrl: string };
    },
  });
}

export function useRedeemInviteCode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (inviteCode: string) => {
      const response = await apiClient.post('/referrals/redeem', { inviteCode });
      return response.data as { success: boolean; creditsAwarded: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['referral-info'] });
      queryClient.invalidateQueries({ queryKey: ['credits'] });
    },
  });
}
