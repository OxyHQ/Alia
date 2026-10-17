import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import type {
  Agent,
  AgentFeatureGate,
  AgentFeatureGates,
  GatedFeature,
} from '@/shared/contracts/agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** An Oxy app and the features of its live catalogue a gate may name. */
export interface GateableApp {
  appId: string;
  name: string;
  features: Array<{ key: string; description: string }>;
}

interface FeatureGateOptions {
  features: GatedFeature[];
  gates: AgentFeatureGates;
  apps: GateableApp[];
}

export interface AgentFeatureGatesState {
  /** `hidden` for anybody who does not operate the agent (403). */
  status: 'loading' | 'ready' | 'failed' | 'hidden';
  features: GatedFeature[];
  gates: AgentFeatureGates;
  apps: GateableApp[];
  /** Put `feature` behind `gate`, or take its gate away with `null`. */
  setGate: (feature: GatedFeature, gate: AgentFeatureGate | null) => void;
}

const NO_OPTIONS: FeatureGateOptions = { features: [], gates: {}, apps: [] };

/**
 * Which of Alia's features an app's entitlement unlocks for this agent (ADR
 * 0020 §6), and what each could be put behind.
 *
 * The options are `GET /agents/:id/feature-gate-options`: the gateable
 * features of the live catalogues, the same ones `PATCH /agents/:id` checks a
 * gate against. A change is saved on its own — never with the draft's
 * autosave, so a catalogue that cannot be read costs this section and not the
 * prompt — shown at once and put back if the save is refused.
 */
export function useAgentFeatureGates(agentId: string): AgentFeatureGatesState {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const key = queryKeys.agents.featureGates(agentId);

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<FeatureGateOptions | null> => {
      try {
        const response = await apiClient.get<FeatureGateOptions>(
          API_ROUTES.agents.featureGateOptions(agentId),
        );
        return {
          features: response.data.features ?? [],
          gates: response.data.gates ?? {},
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
    mutationFn: async (gates: AgentFeatureGates) => {
      const response = await apiClient.patch<{ agent: Agent }>(API_ROUTES.agents.update(agentId), {
        featureGates: gates,
      });
      return response.data.agent;
    },
    onMutate: async (gates) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<FeatureGateOptions | null>(key);
      queryClient.setQueryData<FeatureGateOptions | null>(key, (current) =>
        current ? { ...current, gates } : current,
      );
      return { previous };
    },
    onError: (_error, _gates, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast.error(t('agents.featureGates.saveFailed'));
    },
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agents.detail(agent._id), agent);
      queryClient.setQueryData<FeatureGateOptions | null>(key, (current) =>
        current ? { ...current, gates: agent.featureGates ?? current.gates } : current,
      );
    },
  });

  const options = query.data ?? NO_OPTIONS;
  const status: AgentFeatureGatesState['status'] = query.isPending
    ? 'loading'
    : query.isError
      ? 'failed'
      : query.data === null
        ? 'hidden'
        : 'ready';

  return {
    status,
    features: options.features,
    gates: options.gates,
    apps: options.apps,
    setGate: (feature, gate) => {
      const current = options.gates[feature];
      if (current?.app === gate?.app && current?.feature === gate?.feature) return;
      const next: AgentFeatureGates = { ...options.gates };
      if (gate === null) delete next[feature];
      else next[feature] = gate;
      mutation.mutate(next);
    },
  };
}
