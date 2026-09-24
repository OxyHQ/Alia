import { queryKeys } from './query-keys';
import { useAuthQuery } from './create-query';

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
