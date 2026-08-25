import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';
import type { Agent } from '../types/agents';

/**
 * The agents this person owns — the sidebar's own list, not the marketplace's.
 *
 * `useAgentCatalogue` reads `GET /agents`, which is the CATALOGUE:
 * everything published, by anybody, filtered by category and search. The
 * sidebar wants the opposite list — the ones this person made, published or
 * not — which is `GET /agents/me`, scoped by author in the query rather than
 * filtered afterwards.
 *
 * Their identities are resolved through the same batched Oxy lookup that fails
 * open, so `name`, `handle` and `color` are all nullable and every row renders
 * through the shared fallbacks.
 *
 * The array ARRIVES ordered — the agent last spoken to first, then by when each
 * was made — and the sidebar renders it in that order. `use-agent-row-preview`
 * keeps that true between loads; nothing else may sort it, because a second
 * order would only disagree with the one the next fetch brings.
 */
export function useMyAgents() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.agents.mine,
    queryFn: async (): Promise<Agent[]> => {
      const response = await apiClient.get<{ agents: Agent[] }>(API_ROUTES.agents.me);
      return response.data.agents;
    },
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5,
  });
}
