import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';

export interface AgentTeam {
  id: string;
  name: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

export function useAgentTeams() {
  return useQuery({
    queryKey: ['agent-teams'],
    queryFn: async () => (await apiClient.get<{ teams: AgentTeam[] }>(API_ROUTES.agents.teams)).data.teams,
  });
}
