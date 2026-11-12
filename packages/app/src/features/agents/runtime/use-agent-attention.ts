import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * What an agent notices on its own (ADR 0026): the events it subscribes to, and the inbox they
 * land in until its heartbeat wakes it. The heartbeat interval itself is `scheduleInterval` on the
 * agent, written with `useUpdateAgent`.
 */

/** One subscription, as `GET /agents/:id/subscriptions` lists it. */
export interface AgentSubscription {
  id: string;
  agentId: string;
  ownerAccountId: string;
  /** The account whose events this hears: the owner's, or the agent's own. */
  sourceAccountId: string;
  appId: string;
  eventType: string;
  enabled: boolean;
}

/** Whose events a subscription hears. `owner` is only accepted from the agent's owner. */
export type SubscriptionAccount = 'owner' | 'agent';

export interface NewSubscription {
  appId: string;
  eventType: string;
  account: SubscriptionAccount;
}

/** One thing waiting in the inbox. `summary` is untrusted text from other people: plain text only. */
export interface AgentInboxItem {
  id: string;
  appId: string;
  eventType: string;
  summary: unknown;
  status: 'pending' | 'delivered' | 'dismissed';
  receivedAt: string;
}

/** What waits for the agent, and how often it looks (`GET /agents/:id/inbox`). */
export interface AgentInbox {
  items: AgentInboxItem[];
  workStatus?: {
    state: 'paused' | 'working' | 'scheduled' | 'blocked' | 'waiting';
    reason: string | null;
    nextWakeAt?: string;
  };
  /** The heartbeat in minutes (null: none) and when it last woke the agent (null: never). */
  heartbeat: { intervalMinutes: number | null; lastHeartbeatAt: string | null };
}

export function useAgentSubscriptions(agentId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.subscriptions(agentId),
    queryFn: async (): Promise<AgentSubscription[]> => {
      const response = await apiClient.get<{ subscriptions: AgentSubscription[] }>(
        API_ROUTES.agents.subscriptions(agentId),
      );
      return response.data.subscriptions ?? [];
    },
    enabled: isAuthenticated && agentId !== '',
    retry: false,
  });
}

/** The pending items, newest first (the route's order; nothing here re-sorts it), and the heartbeat. */
export function useAgentInbox(agentId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.inbox(agentId),
    queryFn: async (): Promise<AgentInbox> => {
      const response = await apiClient.get<{
        items?: AgentInboxItem[];
        workStatus?: AgentInbox['workStatus'];
        heartbeat?: Partial<AgentInbox['heartbeat']>;
      }>(API_ROUTES.agents.inbox(agentId), { params: { status: 'pending' } });
      return {
        items: response.data.items ?? [],
        ...(response.data.workStatus ? { workStatus: response.data.workStatus } : {}),
        heartbeat: {
          intervalMinutes: response.data.heartbeat?.intervalMinutes ?? null,
          lastHeartbeatAt: response.data.heartbeat?.lastHeartbeatAt ?? null,
        },
      };
    },
    enabled: isAuthenticated && agentId !== '',
    retry: false,
  });
}

/** Subscribing and unsubscribing. A refusal rejects, so the screen can say why (409: the cap). */
export function useAgentSubscriptionMutations(agentId: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.subscriptions(agentId) });

  const subscribe = useMutation({
    mutationFn: async (input: NewSubscription): Promise<AgentSubscription> => {
      const response = await apiClient.post<{ subscription: AgentSubscription }>(
        API_ROUTES.agents.subscriptions(agentId),
        input,
      );
      return response.data.subscription;
    },
    onSuccess: invalidate,
  });

  const unsubscribe = useMutation({
    mutationFn: async (subscriptionId: string) => {
      await apiClient.delete(API_ROUTES.agents.subscription(agentId, subscriptionId));
    },
    onSuccess: invalidate,
  });

  return { subscribe, unsubscribe };
}
