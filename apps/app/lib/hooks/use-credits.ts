import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

export interface CreditsInfo {
  credits: number;
  freeCredits: number;
  freeLimit: number;
  paidCredits: number;
  dailyRefresh: number;
  lastRefresh: string;
}

async function fetchCredits(): Promise<CreditsInfo> {
  const response = await apiClient.get('/credits');
  return response.data;
}

export function useCredits() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['credits'],
    queryFn: fetchCredits,
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
    enabled: isAuthenticated,
  });
}

export interface DailyUsage {
  date: string;
  used: number;
}

async function fetchCreditsUsage(period: string): Promise<DailyUsage[]> {
  const response = await apiClient.get('/credits/usage', { params: { period } });
  return response.data;
}

export function useCreditsUsage(period: '7d' | '30d' = '7d') {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['credits-usage', period],
    queryFn: () => fetchCreditsUsage(period),
    staleTime: 1000 * 30, // 30 seconds
    refetchOnMount: 'always',
    retry: 2,
    enabled: isAuthenticated,
  });
}
