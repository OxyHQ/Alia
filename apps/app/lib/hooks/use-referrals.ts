import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import { useAuthQuery } from './create-query';

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

export function useReferralInfo() {
  return useAuthQuery<ReferralInfo>(queryKeys.referrals.info, '/referrals');
}

export function useReferralHistory() {
  return useAuthQuery<ReferralHistory>(queryKeys.referrals.history, '/referrals/history', undefined, { staleTime: 60_000 });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.referrals.info });
      queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
    },
  });
}
