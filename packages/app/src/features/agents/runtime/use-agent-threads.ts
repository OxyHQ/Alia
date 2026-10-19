import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';

export interface AgentThreadSummary {
  id: string;
  title: string;
  status: 'open' | 'closed';
  executionTarget: 'sandbox' | 'cowork';
  updatedAt: string;
}

export function useAgentThreads(agentId: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: ['agents', agentId, 'threads'],
    queryFn: async () => {
      const response = await apiClient.get<{ threads: AgentThreadSummary[] }>(
        API_ROUTES.agents.threads(agentId!),
      );
      return response.data.threads;
    },
    enabled: isAuthenticated && Boolean(agentId),
  });
}
