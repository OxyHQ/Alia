import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import apiClient from '../api/client';

/**
 * The agent a task ran, as the listing embeds it.
 *
 * `name`, `handle` and `color` are the bot ACCOUNT's — the API resolves them
 * from Oxy for the whole page in one call — so all three are nullable: an
 * account Oxy cannot resolve leaves them null and the card still draws, because
 * the task, the plan and the stats are Alia's own.
 */
export interface TaskAgentRef {
  _id: string;
  /** The Oxy `bot` account the agent IS. */
  oxyAccountId: string;
  name: string | null;
  handle: string | null;
  color: string | null;
}

export interface TaskSession {
  _id: string;
  agentId: TaskAgentRef | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  task: string;
  result?: string;
  plan?: {
    objective: string;
    items: Array<{
      id: number;
      text: string;
      status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    }>;
  };
  stats: {
    totalTokens: number;
    totalSteps: number;
    startedAt?: string;
    completedAt?: string;
    lastActivityAt: string;
  };
  createdAt: string;
  childAgents?: TaskAgentRef[];
  /**
   * The automation run this session executes a stage of, when it does.
   *
   * `agent_sessions.automation_run_id` exists and the row carries it, but the
   * listing projection (`LISTING_COLUMNS` in the API's session repository)
   * does not yet select it, so today this is absent. It is declared so the
   * unified Tasks list (`unifiedWorkItems`) folds such a session under its
   * automation the moment the listing carries it, instead of showing the run
   * and its parent as two unrelated pieces of work.
   */
  automationRunId?: string | null;
}

export function useActiveTasks() {
  const { isAuthenticated } = useOxy();

  return useQuery<{ sessions: TaskSession[] }>({
    queryKey: ['tasks', 'active'],
    queryFn: async () => {
      const res = await apiClient.get('/agents/sessions/active');
      return res.data;
    },
    staleTime: 5_000,
    refetchInterval: 10_000, // Poll every 10s for active tasks
    enabled: isAuthenticated,
  });
}

export function useTaskHistory(page = 1, limit = 20) {
  const { isAuthenticated } = useOxy();

  return useQuery<{ sessions: TaskSession[]; total: number; page: number; limit: number }>({
    queryKey: ['tasks', 'history', page, limit],
    queryFn: async () => {
      const res = await apiClient.get('/agents/sessions/history', {
        params: { page, limit },
      });
      return res.data;
    },
    staleTime: 30_000,
    enabled: isAuthenticated,
  });
}

export function useTaskStatus(sessionId: string | null) {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['tasks', 'status', sessionId],
    queryFn: async () => {
      const res = await apiClient.get(`/agents/sessions/${sessionId}/status`);
      return res.data;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
    enabled: isAuthenticated && !!sessionId,
  });
}
