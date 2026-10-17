import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useTranslation } from '@/shared/i18n/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** *Nada* · *Ver* · *Ver y actuar* — the three answers to "may this agent use my X?". */
export type OxyAppLevel = 'none' | 'read' | 'act';

/** One Oxy app, as `GET /agents/:id/oxy-apps` serves it. */
export interface AgentOxyApp {
  appId: string;
  name: string;
  level: OxyAppLevel;
  /** The levels this app offers; `none` always. */
  levels: OxyAppLevel[];
}

export interface AgentOxyApps {
  apps: AgentOxyApp[];
  /**
   * `hidden` when the API answers 403: the owner's levels are grants over the
   * OWNER's data, and the ceilings are for whoever operates the agent, so
   * nobody else is shown either.
   */
  status: 'loading' | 'ready' | 'failed' | 'hidden';
  setLevel: (app: AgentOxyApp, level: OxyAppLevel) => void;
}

/**
 * The agent's level per Oxy app, and changing one.
 *
 * A change is shown at once and undone if Oxy refuses it: the server writes the
 * level only after Oxy accepted the grant, so the list it answers next is the
 * truth either way.
 */
export function useAgentOxyApps(agentId: string): AgentOxyApps {
  return useAppLevels({
    key: queryKeys.agents.oxyApps(agentId),
    list: API_ROUTES.agents.oxyApps(agentId),
    item: (appId) => API_ROUTES.agents.oxyApp(agentId, appId),
    saveFailed: 'agents.oxyApps.saveFailed',
    // A level decides which tools the editor offers as primary tools.
    reaches: queryKeys.agents.primaryTools(agentId),
  });
}

/**
 * What the agent may do, per Oxy app, on the data of WHOEVER uses it — its
 * published ceiling (ADR 0020 §2, Oxy ADR 0042). The same three levels and the
 * same optimistic change as {@link useAgentOxyApps}; hidden (403) for anybody
 * who does not operate the agent.
 */
export function useAgentRequesterApps(agentId: string): AgentOxyApps {
  return useAppLevels({
    key: queryKeys.agents.requesterApps(agentId),
    list: API_ROUTES.agents.requesterApps(agentId),
    item: (appId) => API_ROUTES.agents.requesterApp(agentId, appId),
    saveFailed: 'agents.requesterApps.saveFailed',
    // A level decides which tools the editor offers as primary tools.
    reaches: queryKeys.agents.primaryTools(agentId),
  });
}

function useAppLevels(source: {
  key: readonly unknown[];
  list: string;
  item: (appId: string) => string;
  saveFailed: string;
  /** What else reads these levels, refreshed once a change is saved. */
  reaches: readonly unknown[];
}): AgentOxyApps {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const { key } = source;

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<AgentOxyApp[] | null> => {
      try {
        const response = await apiClient.get<{ apps: AgentOxyApp[] }>(source.list);
        return response.data.apps ?? [];
      } catch (error) {
        if (errorStatus(error) === 403) return null;
        throw error;
      }
    },
    enabled: isAuthenticated,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async ({ app, level }: { app: AgentOxyApp; level: OxyAppLevel }) => {
      const response = await apiClient.put<{ app: AgentOxyApp }>(source.item(app.appId), {
        level,
      });
      return response.data.app;
    },
    onMutate: async ({ app, level }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AgentOxyApp[] | null>(key);
      queryClient.setQueryData<AgentOxyApp[] | null>(
        key,
        (current) =>
          current?.map((entry) => (entry.appId === app.appId ? { ...entry, level } : entry)) ??
          current,
      );
      return { previous };
    },
    onError: (_error, { app }, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast.error(t(source.saveFailed, { app: app.name }));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<AgentOxyApp[] | null>(
        key,
        (current) =>
          current?.map((entry) => (entry.appId === saved.appId ? saved : entry)) ?? current,
      );
      void queryClient.invalidateQueries({ queryKey: source.reaches });
    },
  });

  const status: AgentOxyApps['status'] = query.isPending
    ? 'loading'
    : query.isError
      ? 'failed'
      : query.data === null
        ? 'hidden'
        : 'ready';

  return {
    apps: query.data ?? [],
    status,
    setLevel: (app, level) => {
      if (app.level !== level) mutation.mutate({ app, level });
    },
  };
}
