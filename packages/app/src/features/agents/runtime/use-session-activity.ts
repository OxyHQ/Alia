import apiClient from '@/shared/api/client';
import { useQuery } from '@tanstack/react-query';

/**
 * One agent session's activity: what it was asked, and every event it logged.
 *
 * Read through `/agents/any/sessions/:id/activity` — `any` because the route
 * validates that the session is the caller's, whichever agent ran it.
 */

export interface EventEntry {
  _id: string;
  seq: number;
  timestamp: number;
  type: string;
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    exitCode?: number;
    durationMs?: number;
    tokenEstimate?: number;
  };
}

export interface SessionInfo {
  status: string;
  task: string;
  result?: string;
  stats: {
    totalTokens: number;
    totalSteps: number;
    creditsCharged?: number;
    startedAt: string;
    completedAt?: string;
  };
}

export interface SessionActivity {
  entries: EventEntry[];
  session: SessionInfo | null;
}

/**
 * Not retried: an unreadable session shows as an empty timeline straight away,
 * which is what pulling to refresh then retries.
 */
export function useSessionActivity(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['agent-session-activity', sessionId ?? ''],
    queryFn: async (): Promise<SessionActivity> => {
      const res = await apiClient.get(
        `/agents/any/sessions/${sessionId}/activity`,
      );
      return {
        entries: res.data.entries || [],
        session: res.data.session || null,
      };
    },
    enabled: typeof sessionId === 'string' && sessionId.length > 0,
    retry: false,
  });
}

/** An entry that reads as a threat: typed as one, or saying so. */
export function isThreatEntry(entry: EventEntry): boolean {
  return entry.type === 'threat_detected' || !!entry.content?.includes('THREAT');
}

/** How many of the entries are threats and how many errors. */
export function sessionAlertCounts(entries: readonly EventEntry[]): {
  threats: number;
  errors: number;
} {
  return {
    threats: entries.filter(isThreatEntry).length,
    errors: entries.filter((e) => e.type === 'error').length,
  };
}
