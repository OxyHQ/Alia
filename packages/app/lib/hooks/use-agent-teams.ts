import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';

export interface AgentTeam {
  _id: string;
  name: string;
  description?: string;
  creator: string;
  agents: any[];
  skills: Array<{ _id: string; skillId: string; title: string; icon: string; color: string }>;
  knowledge: Array<{ _id: string; name: string; type: string; category: string; url: string }>;
  createdAt: string;
  updatedAt: string;
}

export function useAgentTeams() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.agentTeams.all,
    queryFn: async (): Promise<AgentTeam[]> => {
      const response = await apiClient.get('/agents/teams');
      return response.data.teams;
    },
    staleTime: 1000 * 60 * 2,
    retry: 2,
    enabled: isAuthenticated,
  });
}

export function useAgentTeam(id: string) {
  return useQuery({
    queryKey: queryKeys.agentTeams.detail(id),
    queryFn: async (): Promise<AgentTeam> => {
      const response = await apiClient.get(`/agents/teams/${id}`);
      return response.data.team;
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 2,
    retry: 1,
  });
}

export function useCreateAgentTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const response = await apiClient.post('/agents/teams', data);
      return response.data.team as AgentTeam;
    },
    onSuccess: (newTeam) => {
      queryClient.setQueryData<AgentTeam[]>(queryKeys.agentTeams.all, (old) => {
        if (!old) return [newTeam];
        return [newTeam, ...old];
      });
      queryClient.setQueryData(queryKeys.agentTeams.detail(newTeam._id), newTeam);
    },
  });
}

export function useUpdateAgentTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; description?: string; skills?: string[]; knowledge?: string[] } }) => {
      const response = await apiClient.patch(`/agents/teams/${id}`, data);
      return response.data.team as AgentTeam;
    },
    onSuccess: (updatedTeam) => {
      queryClient.setQueryData<AgentTeam[]>(queryKeys.agentTeams.all, (old) => {
        if (!old) return [updatedTeam];
        return old.map((t) => (t._id === updatedTeam._id ? updatedTeam : t));
      });
      queryClient.setQueryData(queryKeys.agentTeams.detail(updatedTeam._id), updatedTeam);
    },
  });
}

export function useDeleteAgentTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/agents/teams/${id}`);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<AgentTeam[]>(queryKeys.agentTeams.all, (old) => {
        if (!old) return [];
        return old.filter((t) => t._id !== id);
      });
      queryClient.removeQueries({ queryKey: queryKeys.agentTeams.detail(id) });
    },
  });
}

export function useAddAgentToTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, agentId }: { teamId: string; agentId: string }) => {
      const response = await apiClient.post(`/agents/teams/${teamId}/agents`, { agentId });
      return response.data.team as AgentTeam;
    },
    onSuccess: (updatedTeam) => {
      queryClient.setQueryData(queryKeys.agentTeams.detail(updatedTeam._id), updatedTeam);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTeams.all });
    },
  });
}

export function useRemoveAgentFromTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, agentId }: { teamId: string; agentId: string }) => {
      const response = await apiClient.delete(`/agents/teams/${teamId}/agents/${agentId}`);
      return response.data.team as AgentTeam;
    },
    onSuccess: (updatedTeam) => {
      queryClient.setQueryData(queryKeys.agentTeams.detail(updatedTeam._id), updatedTeam);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTeams.all });
    },
  });
}
