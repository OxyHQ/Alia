import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Memory is per actor: Alia's is `GET /memory` (`use-user-data.ts`), and each
 * agent keeps its own files about the person (`agent_memory_documents`). These
 * hooks are the agents' half — which agents remember something, what one of
 * them remembers, editing it and forgetting it.
 */

/** One agent that remembers something about the caller, as `GET /memory/agents` lists it. */
export interface RememberingAgent {
  agentId: string;
  name: string | null;
  handle: string | null;
  color: string | null;
  files: number;
  updatedAt: string | null;
}

export function useRememberingAgents() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.remembering,
    queryFn: async (): Promise<RememberingAgent[]> => {
      const response = await apiClient.get<{ agents: RememberingAgent[] }>(API_ROUTES.memory.agents);
      return response.data.agents ?? [];
    },
    enabled: isAuthenticated,
  });
}

/** One memory file, as `GET /agents/:id/memory` lists it. */
export interface AgentMemoryFile {
  path: string;
  byteLength: number;
  updatedAt: string;
}

/** One file's content and the hash a save must name. */
export interface AgentMemoryDocument {
  path: string;
  content: string;
  hash: string;
  exists: boolean;
}

/** `null` when the agent is not one the caller may address (404). */
export function useAgentMemoryFiles(agentId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.memory(agentId),
    queryFn: async (): Promise<AgentMemoryFile[] | null> => {
      try {
        const response = await apiClient.get<{ documents: AgentMemoryFile[] }>(API_ROUTES.agents.memory(agentId));
        return response.data.documents ?? [];
      } catch (error) {
        if (errorStatus(error) === 404) return null;
        throw error;
      }
    },
    enabled: isAuthenticated && agentId !== '',
    retry: false,
  });
}

export function useAgentMemoryDocument(agentId: string, path: string | null) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.memoryFile(agentId, path ?? ''),
    queryFn: async (): Promise<AgentMemoryDocument> => {
      const response = await apiClient.get<AgentMemoryDocument>(API_ROUTES.agents.memory(agentId), {
        params: { path },
      });
      return response.data;
    },
    enabled: isAuthenticated && agentId !== '' && path !== null,
  });
}

/** Saving (with the hash it was read at) and forgetting one file or everything. */
export function useAgentMemoryMutations(agentId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.memory(agentId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.remembering }),
  ]);

  const save = useMutation({
    mutationFn: async (input: { path: string; content: string; expectedHash: string }) => {
      await apiClient.put(API_ROUTES.agents.memory(agentId), input);
    },
    onSuccess: invalidate,
  });

  const forget = useMutation({
    /** `path` omitted forgets everything this agent remembers about the caller. */
    mutationFn: async (path?: string) => {
      await apiClient.delete(API_ROUTES.agents.memory(agentId), { params: path === undefined ? {} : { path } });
    },
    onSuccess: invalidate,
  });

  return { save, forget };
}
