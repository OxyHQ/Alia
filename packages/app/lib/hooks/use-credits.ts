import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import { useAuthQuery } from './create-query';

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
  /**
   * The plan's rolling usage window — credits spent in the last `hours` of the
   * `limit` it allows, and when the oldest spend ages out (`resetsAt`, ISO, or
   * null when nothing is spent). `null` when the plan has none. Absent from an
   * API older than the window.
   */
  window?: { hours: number; used: number; limit: number; resetsAt: string | null } | null;
}

export function useCredits() {
  return useAuthQuery<CreditsInfo>(queryKeys.credits.info, '/credits', undefined, { staleTime: 60_000 });
}

// --- Credit usage chart ---

export interface DailyUsage {
  date: string;
  used: number;
}

export function useCreditsUsage(period: UsagePeriod = '24h') {
  return useAuthQuery<DailyUsage[]>(queryKeys.credits.usage(period), '/credits/usage', { period }, { staleTime: 30_000 });
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
    queryKey: queryKeys.credits.analytics(period),
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
