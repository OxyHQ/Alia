import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { queryKeys } from './query-keys';
import { errorStatus } from '../errors/error-utils';
import type { Agent, AgentCreate, AgentUpdate } from '../types/agents';

/**
 * Reading and writing agents.
 *
 * This replaces `lib/stores/agents-store.ts`, which kept `agents`, `loading`,
 * `error` and `total` in Zustand. None of those four was client state: they were
 * a hand-maintained cache of the server's, with hand-written optimistic edits
 * (`state.agents.map(...)`, `state.agents.filter(...)`) alongside a TanStack
 * query reading the SAME data through `useMyAgents`.
 *
 * Two caches of one thing is why writing through one could not tell the other,
 * and a freshly created agent did not appear in the sidebar. The fix is not a
 * message between them — it is that there is only one now, and the mutations
 * below say what they invalidate.
 */

/**
 * The lists a write makes wrong.
 *
 * Named once because all three writes make the same two wrong, and because
 * "which lists does this affect" is the question the old store could not
 * answer at all. Creating, deleting, renaming, recolouring or republishing an
 * agent all change BOTH the person's own list and the catalogue it may appear
 * in — so both are said out loud rather than left to a `refetchOnMount` to
 * paper over.
 */
async function invalidateAgentLists(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine }),
    // The prefix, not one filtered key: the catalogue is cached per filter, and
    // a new agent belongs to every filter it matches rather than to the one the
    // last screen happened to use.
    queryClient.invalidateQueries({ queryKey: ['agents', 'catalogue'] }),
  ]);
}

export interface AgentCatalogueParams {
  category?: string;
  search?: string;
  featured?: string;
  trending?: string;
}

/**
 * The catalogue: everything published, by anybody, narrowed by the screen's
 * filters. NOT the same question as `useMyAgents`, which asks for the ones this
 * person made whether published or not.
 */
export function useAgentCatalogue(params?: AgentCatalogueParams) {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.agents.catalogue(params),
    queryFn: async (): Promise<{ agents: Agent[]; total: number }> => {
      const response = await apiClient.get<{ agents: Agent[]; total: number }>(
        API_ROUTES.agents.list,
        params ? { params } : undefined,
      );
      return { agents: response.data.agents, total: response.data.total };
    },
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * One agent, whole. `undefined` id is a screen that has not resolved its route yet.
 *
 * ## Not before the session can sign the request
 *
 * `GET /agents/:id` is `optionalAuth`, and an unpublished draft is served only
 * to a caller the route can verify — to anyone else it is a 404, on purpose.
 * On a full page load this query used to go out the moment the route resolved
 * its id, which is BEFORE the Oxy session has minted its bearer: the request
 * left without an `Authorization` header, the route correctly answered 404 for
 * the person's own draft, and the editor sat on "Loading…" for as long as the
 * tab stayed open (#530). `GET /agents/me`, gated on the session, listed the
 * same agent a moment later.
 *
 * `isPrivateApiPending` is the SDK's own name for that gap: true until auth is
 * resolved and, for a signed-in session, until the token is actually in hand.
 * It is deliberately NOT `isAuthenticated` — that is `user !== null`, which the
 * persisted store restores before the bearer exists, so it is the very flag
 * that let the race through; and a signed-out reader of a PUBLISHED agent is a
 * legitimate caller of this route, whom an `isAuthenticated` gate would leave
 * loading forever. When the flag clears the query enables itself and fetches,
 * which is the whole recovery: nothing else has to notice.
 *
 * A 404 is not retried. The route answers it deliberately — the agent is gone,
 * or not this person's to see — and three more tries with the same credential
 * would only stretch the loading state the screen is trying to leave.
 */
export function useAgent(id: string | undefined) {
  const { isPrivateApiPending } = useOxy();

  return useQuery({
    queryKey: queryKeys.agents.detail(id ?? ''),
    queryFn: async (): Promise<Agent> => {
      const response = await apiClient.get<{ agent: Agent }>(API_ROUTES.agents.get(id ?? ''));
      return response.data.agent;
    },
    enabled: typeof id === 'string' && id.length > 0 && !isPrivateApiPending,
    retry: (failureCount, error) => errorStatus(error) !== 404 && failureCount < 3,
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: AgentCreate): Promise<Agent> => {
      const response = await apiClient.post<{ agent: Agent }>(API_ROUTES.agents.create, data);
      return response.data.agent;
    },
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agents.detail(agent._id), agent);
      return invalidateAgentLists(queryClient);
    },
  });
}

/**
 * A refused save REACHES THE SCREEN, which is the property this carries over
 * from the store it replaces.
 *
 * The store's `updateAgent` rethrew on purpose: it used to swallow the error,
 * and the editor — which caught silently — cleared its spinner and looked
 * saved while every autosave it sent was a 400. A mutation rejects by default,
 * so `mutateAsync` keeps that; `onSuccess` is what makes invalidation
 * conditional on the write having actually landed.
 */
export function useUpdateAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: AgentUpdate }): Promise<Agent> => {
      const response = await apiClient.patch<{ agent: Agent }>(
        API_ROUTES.agents.update(id),
        updates,
      );
      return response.data.agent;
    },
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agents.detail(agent._id), agent);
      return invalidateAgentLists(queryClient);
    },
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      await apiClient.delete(API_ROUTES.agents.delete(id));
      return id;
    },
    onSuccess: (id) => {
      // The agent is gone, so its own entry is not merely stale.
      queryClient.removeQueries({ queryKey: queryKeys.agents.detail(id) });
      return invalidateAgentLists(queryClient);
    },
  });
}
