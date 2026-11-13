import { useOxy } from '@oxy.so/services/ui/client';
import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { useAuthQuery } from '@/shared/api/create-query';

export interface CreditsInfo {
  subjectAccountId?: string;
  productAllowance?: {
    source: 'oxy_one' | 'oxy_product';
    planId: string;
    periodStart: string;
    periodEnd: string;
    included: number;
    consumed: number;
    reserved: number;
    remaining: number;
  } | null;
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
  const query = useAuthQuery<CreditsInfo>(
    [...queryKeys.credits.info, subject, activeSessionId],
    '/credits',
    undefined,
    {
      enabled: isAuthenticated && !!subject && !!activeSessionId,
      // No polling (it was every 10 s from the composer on every chat: a quarter of the API calls
      // that rate-limited an active person on Gemies, 2026-11-13). The balance moves when a turn
      // ends (`use-alia-host` invalidates it), on a purchase or a referral (they invalidate it), and
      // is revalidated when the tab comes back. This session's last balance stays in memory, never
      // on disk, and is drawn meanwhile. Realtime: a `credits:changed` socket event would
      // invalidate `queryKeys.credits.info` here.
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      queryFn: async () => {
        const { data } = await apiClient.get('/credits');
        if (data.subjectAccountId !== subject) throw new Error('Credit account changed');
        return data;
      },
    },
  );
  return { ...query, data: query.isError || !isAuthenticated ? undefined : query.data };
}
