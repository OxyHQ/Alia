import apiClient from '@/shared/api/client';
import { errorResponseData, errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import type { Space, SpaceCreate, SpaceErrorCode, SpaceUpdate } from '@/shared/contracts/spaces';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Spaces (ADR 0028): the folders that group the person's own agents. A space is a server entity
 * (membership, the brief and the room live in the API), so this is the data layer of the sidebar's
 * Spaces section: the list, and one mutation per thing the person can do to a space.
 */

/** The person's spaces, with their members and rooms (`GET /spaces`). */
export function useSpaces() {
  const { canUsePrivateApi, isAccountCacheReady } = useOxy();
  return useQuery({
    queryKey: queryKeys.spaces.all,
    queryFn: async ({ signal }): Promise<Space[]> => {
      const response = await apiClient.get<{ spaces: Space[] }>(API_ROUTES.spaces.list, { signal });
      return response.data.spaces ?? [];
    },
    enabled: canUsePrivateApi && isAccountCacheReady,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * The API's `code` of a refused space request (`space_full`, `agent_in_other_space`), or `undefined`
 * for any other failure. The 409 is the only status that carries one the sidebar acts on.
 */
export function spaceErrorCode(error: unknown): SpaceErrorCode | undefined {
  if (errorStatus(error) !== 409) return undefined;
  const code = errorResponseData(error)?.code;
  return code === 'space_full' || code === 'agent_in_other_space' ? code : undefined;
}

/** Agents leave and join spaces, rooms appear and go: all three lists must be read again. */
function useRefreshSpaces() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine }),
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all }),
    ]);
}

/**
 * Create, rename, rewrite the brief of and delete a space, and put agents in and take them out.
 * Every mutation re-reads spaces, the person's agents (`spaceId`) and conversations (the room), and
 * a refusal rejects, so the caller can say why (`spaceErrorCode`).
 */
export function useSpaceMutations() {
  const refresh = useRefreshSpaces();

  const createSpace = useMutation({
    mutationFn: async (input: SpaceCreate): Promise<Space> => {
      const response = await apiClient.post<{ space: Space }>(API_ROUTES.spaces.list, input);
      return response.data.space;
    },
    onSuccess: refresh,
  });

  const updateSpace = useMutation({
    mutationFn: async ({ id, ...changes }: SpaceUpdate & { id: string }): Promise<Space> => {
      const response = await apiClient.patch<{ space: Space }>(
        API_ROUTES.spaces.detail(id),
        changes,
      );
      return response.data.space;
    },
    onSuccess: refresh,
  });

  const deleteSpace = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await apiClient.delete(API_ROUTES.spaces.detail(id));
    },
    onSuccess: refresh,
  });

  /** Put an agent in a space; it leaves the one it was in. */
  const moveAgent = useMutation({
    mutationFn: async ({
      spaceId,
      agentId,
    }: {
      spaceId: string;
      agentId: string;
    }): Promise<Space> => {
      const response = await apiClient.put<{ space: Space }>(
        API_ROUTES.spaces.member(spaceId, agentId),
      );
      return response.data.space;
    },
    onSuccess: refresh,
  });

  /** Take an agent out of its space; it goes back to the flat list. */
  const removeAgent = useMutation({
    mutationFn: async ({
      spaceId,
      agentId,
    }: {
      spaceId: string;
      agentId: string;
    }): Promise<void> => {
      await apiClient.delete(API_ROUTES.spaces.member(spaceId, agentId));
    },
    onSuccess: refresh,
  });

  return { createSpace, updateSpace, deleteSpace, moveAgent, removeAgent };
}
