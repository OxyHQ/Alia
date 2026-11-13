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
      // No timer: the balance is the server's `credits` event on the account's realtime connection
      // (`useAppRealtime`), on every device, when a turn settles, a purchase lands or a referral
      // pays; a client too far behind to catch up reads it again once. This session's last
      // balance stays in memory to be drawn meanwhile (never on disk).
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      queryFn: async () => {
        const { data } = await apiClient.get('/credits');
        if (data.subjectAccountId !== subject) throw new Error('Credit account changed');
        return data;
      },
    },
  );
  return { ...query, data: query.isError || !isAuthenticated ? undefined : query.data };
}
