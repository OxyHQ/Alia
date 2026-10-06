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
   * `hidden` when the person is not the agent's owner (403): the levels are
   * grants over the OWNER's data, so nobody else is shown them.
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
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const key = queryKeys.agents.oxyApps(agentId);

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<AgentOxyApp[] | null> => {
      try {
        const response = await apiClient.get<{ apps: AgentOxyApp[] }>(API_ROUTES.agents.oxyApps(agentId));
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
      const response = await apiClient.put<{ app: AgentOxyApp }>(
        API_ROUTES.agents.oxyApp(agentId, app.appId),
        { level },
      );
      return response.data.app;
    },
    onMutate: async ({ app, level }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AgentOxyApp[] | null>(key);
      queryClient.setQueryData<AgentOxyApp[] | null>(key, (current) =>
        current?.map((entry) => (entry.appId === app.appId ? { ...entry, level } : entry)) ?? current,
      );
      return { previous };
    },
    onError: (_error, { app }, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast.error(t('agents.oxyApps.saveFailed', { app: app.name }));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<AgentOxyApp[] | null>(key, (current) =>
        current?.map((entry) => (entry.appId === saved.appId ? saved : entry)) ?? current,
      );
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
