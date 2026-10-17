import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import type { Agent } from '@/shared/contracts/agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** One app tool the agent reaches. */
export interface PrimaryToolOption {
  /** `<appId>:<tool>`, what `primaryTools` holds. */
  key: string;
  name: string;
  description: string;
}

/** An Oxy app the agent reaches, on its owner's levels or on its ceiling for whoever uses it. */
export interface PrimaryToolApp {
  appId: string;
  name: string;
  tools: PrimaryToolOption[];
}

interface PrimaryToolOptions {
  primaryTools: string[];
  max: number;
  apps: PrimaryToolApp[];
}

export interface AgentPrimaryToolsState {
  /** `hidden` for anybody who does not operate the agent (403). */
  status: 'loading' | 'ready' | 'failed' | 'hidden';
  primaryTools: string[];
  max: number;
  apps: PrimaryToolApp[];
  /** Make `key` one of the agent's primary tools, or stop it being one. */
  toggle: (key: string) => void;
}

const NO_OPTIONS: PrimaryToolOptions = { primaryTools: [], max: 0, apps: [] };

/**
 * The app tools active from the first step of every turn the agent leads, and
 * the tools it reaches that could be.
 *
 * The options are `GET /agents/:id/primary-tool-options`. A change is saved on
 * its own — never with the draft's autosave, so a catalogue that cannot be
 * read costs this section and not the prompt — shown at once and put back if
 * the save is refused.
 */
export function useAgentPrimaryTools(agentId: string): AgentPrimaryToolsState {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const key = queryKeys.agents.primaryTools(agentId);

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<PrimaryToolOptions | null> => {
      try {
        const response = await apiClient.get<PrimaryToolOptions>(
          API_ROUTES.agents.primaryToolOptions(agentId),
        );
        return {
          primaryTools: response.data.primaryTools ?? [],
          max: response.data.max ?? 0,
          apps: response.data.apps ?? [],
        };
      } catch (error) {
        if (errorStatus(error) === 403) return null;
        throw error;
      }
    },
    enabled: isAuthenticated,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (primaryTools: string[]) => {
      const response = await apiClient.patch<{ agent: Agent }>(API_ROUTES.agents.update(agentId), {
        primaryTools,
      });
      return response.data.agent;
    },
    onMutate: async (primaryTools) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<PrimaryToolOptions | null>(key);
      queryClient.setQueryData<PrimaryToolOptions | null>(key, (current) =>
        current ? { ...current, primaryTools } : current,
      );
      return { previous };
    },
    onError: (_error, _tools, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast.error(t('agents.primaryTools.saveFailed'));
    },
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agents.detail(agent._id), agent);
      queryClient.setQueryData<PrimaryToolOptions | null>(key, (current) =>
        current
          ? { ...current, primaryTools: agent.primaryTools ?? current.primaryTools }
          : current,
      );
    },
  });

  const options = query.data ?? NO_OPTIONS;
  const status: AgentPrimaryToolsState['status'] = query.isPending
    ? 'loading'
    : query.isError
      ? 'failed'
      : query.data === null
        ? 'hidden'
        : 'ready';

  return {
    status,
    primaryTools: options.primaryTools,
    max: options.max,
    apps: options.apps,
    toggle: (toolKey) => {
      const chosen = options.primaryTools.includes(toolKey);
      if (!chosen && options.primaryTools.length >= options.max) {
        toast.error(t('agents.primaryTools.full', { max: options.max }));
        return;
      }
      mutation.mutate(
        chosen
          ? options.primaryTools.filter((entry) => entry !== toolKey)
          : [...options.primaryTools, toolKey],
      );
    },
  };
}
