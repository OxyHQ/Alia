import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useTranslation } from '@/shared/i18n/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** One owned agent and whether it tells its owner about important mail in its own mailbox. */
export interface AgentEmailAlert {
  agentId: string;
  name: string | null;
  handle: string | null;
  color: string | null;
  enabled: boolean;
}

/** `GET /notifications/email-alerts`: Alia about the person's Inbox, each agent about its own. */
export interface EmailAlerts {
  alia: { enabled: boolean };
  agents: AgentEmailAlert[];
}

/**
 * "Avísame de emails importantes", per actor. A switch flips at once and comes
 * back if the server refuses it.
 */
export function useEmailAlerts() {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const key = queryKeys.emailAlerts;

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<EmailAlerts> => (await apiClient.get<EmailAlerts>(API_ROUTES.emailAlerts)).data,
    enabled: isAuthenticated,
  });

  const mutation = useMutation({
    mutationFn: async (input: { agentId: string | null; enabled: boolean }) => {
      await apiClient.put(API_ROUTES.emailAlerts, input);
    },
    onMutate: async ({ agentId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<EmailAlerts>(key);
      queryClient.setQueryData<EmailAlerts>(key, (current) => current && (agentId === null
        ? { ...current, alia: { enabled } }
        : { ...current, agents: current.agents.map((agent) => (agent.agentId === agentId ? { ...agent, enabled } : agent)) }));
      return { previous };
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast.error(t('settings.saveFailed'));
    },
  });

  return {
    alerts: query.data,
    loading: query.isPending,
    failed: query.isError,
    setEnabled: (agentId: string | null, enabled: boolean) => mutation.mutate({ agentId, enabled }),
  };
}
