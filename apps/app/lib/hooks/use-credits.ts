import { useQuery } from '@tanstack/react-query';
import apiClient from '../api/client';

export interface CreditsInfo {
  credits: number;
  freeCredits: number;
  dailyRefresh: number;
  lastRefresh: string;
}

async function fetchCredits(): Promise<CreditsInfo> {
  const response = await apiClient.get('/credits');
  return response.data;
}

export function useCredits() {
  return useQuery({
    queryKey: ['credits'],
    queryFn: fetchCredits,
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
  });
}
