import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';
import { useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * What the agent screen writes: whether the agent accepts hires. A thread with an agent is never
 * created from here; it is many ordinary conversations, addressed by the agent's handle
 * (`/@handle?threadId=…`) and begun by the API when the two first speak.
 */

/** Whether the agent accepts hires. The cached record is updated in place. */
export function useSetAgentStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, status }: { agentId: string; status: 'active' | 'idle' }) => {
      await apiClient.patch(API_ROUTES.agents.status(agentId), { status });
    },
    onSuccess: (_, { agentId, status }) => {
      queryClient.setQueryData<Agent>(queryKeys.agents.detail(agentId), (previous) =>
        previous === undefined ? previous : { ...previous, status },
      );
    },
  });
}
