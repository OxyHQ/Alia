import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
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
  const { canUsePrivateApi, isAccountCacheReady } = useOxy();

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
  useEffect(() => {
    if (!canUsePrivateApi || !isAccountCacheReady || !query.data) return;
    const controller = new AbortController();
    // The actual signed-in owner establishes provenance. Events never impersonate that owner.
    void (async () => {
      for (const agent of query.data) {
        if (controller.signal.aborted) break;
        if (agent.status !== 'active' || !agent.scheduleInterval || agent.external) continue;
        await apiClient
          .post(`/agents/${encodeURIComponent(agent._id)}/work`, {}, { signal: controller.signal })
          .catch(() => undefined); // Idempotent; the next successful list refresh retries setup.
      }
    })();
    return () => controller.abort();
  }, [canUsePrivateApi, isAccountCacheReady, query.data, query.dataUpdatedAt]);
  return query;
}
