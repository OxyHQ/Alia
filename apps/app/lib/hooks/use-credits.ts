import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

export interface CreditsInfo {
  credits: number;
  freeCredits: number;
  paidCredits: number;
  dailyRefresh: number;
  lastRefresh: string;
}

async function fetchCredits(): Promise<CreditsInfo> {
  const response = await apiClient.get('/credits');
  return response.data;
}

export function useCredits() {
  const { activeSessionId } = useOxy();

  return useQuery({
    queryKey: ['credits'],
    queryFn: fetchCredits,
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
    enabled: !!activeSessionId,
  });
}
