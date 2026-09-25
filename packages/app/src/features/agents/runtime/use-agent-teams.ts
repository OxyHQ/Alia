import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';

export interface AgentTeam {
  id: string;
  name: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

export function useAgentTeams() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: ['agent-teams'],
    queryFn: async () => (await apiClient.get<{ teams: AgentTeam[] }>(API_ROUTES.agents.teams)).data.teams,
    enabled: isAuthenticated,
  });
}
