import { useQueries, useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { isAxiosError } from 'axios';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';

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
/** How often the sidebar re-reads who is connected, when it lists an external agent. */
const EXTERNAL_PRESENCE_REFRESH_MS = 30_000;

export function useMyAgents() {
  const { user, canUsePrivateApi, isAccountCacheReady } = useOxy();

  const query = useQuery({
    queryKey: queryKeys.agents.mine,
    queryFn: async ({ signal }): Promise<Agent[]> => {
      const response = await apiClient.get<{ agents: Agent[] }>(API_ROUTES.agents.me, { signal });
      return response.data.agents;
    },
    enabled: canUsePrivateApi && isAccountCacheReady,
    staleTime: 1000 * 60 * 5,
    // A connected computer comes and goes: while any of the agents is one, look again now and then.
    refetchInterval: (query) =>
      query.state.data?.some((agent) => agent.external) ? EXTERNAL_PRESENCE_REFRESH_MS : false,
  });
  // This handshake is not persisted. Each agent retries independently, without
  // blocking the sidebar or requiring another list refresh after an outage.
  const eligible =
    canUsePrivateApi && isAccountCacheReady && user?.id
      ? (query.data ?? []).filter(
          (agent) =>
            agent.ownerOxyAccountId === user.id &&
            agent.status === 'active' &&
            agent.scheduleInterval &&
            !agent.external,
        )
      : [];
  useQueries({
    queries: eligible.map((agent) => ({
      queryKey: queryKeys.agents.workAuthority(user?.id ?? '', agent._id),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await apiClient.post(`/agents/${encodeURIComponent(agent._id)}/work`, {}, { signal });
        return true;
      },
      gcTime: 0,
      staleTime: Infinity,
      retry: (attempt: number, error: unknown) => attempt < 2 && retryableActivation(error),
      refetchInterval: (query: { state: { status: string; error: unknown } }) =>
        query.state.status === 'error' && retryableActivation(query.state.error) ? 60_000 : false,
    })),
  });
  return query;
}

function retryableActivation(error: unknown): boolean {
  return !isAxiosError(error) || ![401, 403].includes(error.response?.status ?? 0);
}
