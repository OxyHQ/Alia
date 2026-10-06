import { useOxy } from '@oxy.so/services';
import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { useAuthQuery } from '@/shared/api/create-query';

export interface CreditsInfo {
  subjectAccountId?: string;
  productAllowance?: { source: 'oxy_one'; planId: string; periodStart: string; periodEnd: string; included: number; consumed: number; reserved: number; remaining: number } | null;
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
  const { user, activeSessionId, isAuthenticated } = useOxy();
  const subject = user?.id;
  const query = useAuthQuery<CreditsInfo>([...queryKeys.credits.info, subject, activeSessionId], '/credits', undefined, {
    enabled: isAuthenticated && !!subject && !!activeSessionId, staleTime: 0, gcTime: 0, refetchInterval: 10_000,
    queryFn: async () => {
      const { data } = await apiClient.get('/credits');
      if (data.subjectAccountId !== subject) throw new Error('Credit account changed');
      return data;
    },
  });
  return { ...query, data: query.isError || !isAuthenticated ? undefined : query.data };
}
