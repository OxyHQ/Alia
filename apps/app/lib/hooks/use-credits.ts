import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

// --- Shared period type ---

export type UsagePeriod = '24h' | '48h' | '72h' | '7d';

export const PERIODS: UsagePeriod[] = ['24h', '48h', '72h', '7d'];

const PERIOD_DAYS: Record<UsagePeriod, number> = {
  '24h': 1,
  '48h': 2,
  '72h': 3,
  '7d': 7,
};

// --- Credits ---

export interface CreditsInfo {
  credits: number;
  freeCredits: number;
  freeLimit: number;
  paidCredits: number;
  dailyRefresh: number;
  lastRefresh: string;
}

export function useCredits() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: ['credits'],
    queryFn: async () => {
      const res = await apiClient.get('/credits');
      return res.data as CreditsInfo;
    },
    staleTime: 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });
}

// --- Credit usage chart ---

export interface DailyUsage {
  date: string;
  used: number;
}

export function useCreditsUsage(period: UsagePeriod = '24h') {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: ['credits-usage', period],
    queryFn: async () => {
      const res = await apiClient.get('/credits/usage', { params: { period } });
      return res.data as DailyUsage[];
    },
    staleTime: 30_000,
    retry: 2,
    enabled: isAuthenticated,
  });
}

// --- Analytics ---

export interface UsageDay {
  _id: string;
  conversations: number;
  totalTokens: number;
}

export interface ModelUsage {
  _id: string;
  name: string;
  emoji?: string;
  count: number;
  totalTokens: number;
}

interface AnalyticsData {
  usage: UsageDay[];
  models: ModelUsage[];
}

export function useAnalytics(period: UsagePeriod = '24h') {
  const days = PERIOD_DAYS[period];
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: ['analytics', period],
    queryFn: async () => {
      const [u, m] = await Promise.all([
        apiClient.get('/analytics/usage', { params: { days } }),
        apiClient.get('/analytics/models', { params: { days } }),
      ]);
      return { usage: u.data.usage, models: m.data.models } as AnalyticsData;
    },
    staleTime: 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });
}
