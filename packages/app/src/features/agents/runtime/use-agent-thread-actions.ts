import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';
import { useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * Durable threads with an agent, and the work started in them.
 *
 * The agent screen creates agent THREADS, never bare conversation rows — a
 * thread with an agent is many ordinary conversations, addressed by the
 * agent's handle (`/(app)/[username]?threadId=…`).
 */

async function createThread(agentId: string, title: string): Promise<string> {
  const response = await apiClient.post(API_ROUTES.agents.threads(agentId), {
    title,
    executionTarget: 'sandbox',
    approvalMode: 'ask',
  });
  return String(response.data.thread.id);
}

/**
 * Priced work, started through a GOAL in a thread of its own rather than a
 * hire.
 *
 * The goal carries an idempotency key, so a retried request cannot start the
 * same task twice. Resolves to the thread and, when the run began at once, the
 * session running it.
 */
export function useStartAgentTask() {
  return useMutation({
    mutationFn: async ({
      agentId,
      objective,
    }: {
      agentId: string;
      objective: string;
    }): Promise<{ threadId: string; sessionId: string | null }> => {
      const threadId = await createThread(agentId, objective.slice(0, 120));
      const response = await apiClient.post(
        API_ROUTES.agents.goals(threadId),
        { objective },
        {
          headers: {
            'Idempotency-Key': `${agentId}:${Date.now()}:${Math.random()}`,
          },
        },
      );
      const sessionId = response.data?.sessionId;
      return { threadId, sessionId: sessionId ? String(sessionId) : null };
    },
  });
}

/** Whether the agent accepts hires. The cached record is updated in place. */
export function useSetAgentStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      status,
    }: {
      agentId: string;
      status: 'active' | 'idle';
    }) => {
      await apiClient.patch(API_ROUTES.agents.status(agentId), { status });
    },
    onSuccess: (_, { agentId, status }) => {
      queryClient.setQueryData<Agent>(
        queryKeys.agents.detail(agentId),
        (previous) =>
          previous === undefined ? previous : { ...previous, status },
      );
    },
  });
}
