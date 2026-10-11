import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';

/**
 * An action Alia or an agent asked this person to approve.
 *
 * Two kinds reach here (`packages/api/src/routes/agents/approvals.ts`): a
 * payment or a deletion in an Oxy app — by Alia or by an agent, in a chat or a
 * background task — which approving PERFORMS, once; and an agent's runtime
 * action in a background run, which approving starts a run to perform. The
 * run that asked did not wait, so the answer can come minutes or days later.
 */
export interface PendingAgentApproval {
  id: string;
  /** Who asked: Alia herself (no `agentId`) or an agent. */
  actorType?: 'alia' | 'agent';
  agentId: string | null;
  /** The Alia conversation it belongs to, when it was asked in one. */
  conversationId?: string | null;
  kind?: 'payment' | 'deletion' | null;
  /** The exact action seen; sent back with the decision. */
  hash?: string;
  toolName: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export const agentApprovalsKey = ['agent-approvals'] as const;

/**
 * Which requests a screen shows: an agent's thread shows that agent's; an
 * Alia conversation shows the ones asked in it.
 */
export interface ApprovalScope {
  agentId?: string;
  conversationId?: string;
}

export function approvalInScope(approval: PendingAgentApproval, scope: ApprovalScope): boolean {
  if (scope.agentId) return approval.agentId === scope.agentId;
  if (scope.conversationId) return approval.conversationId === scope.conversationId;
  return true;
}

function useApprovals(scope: ApprovalScope) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: agentApprovalsKey,
    queryFn: async () => {
      const response = await apiClient.get<{ approvals: PendingAgentApproval[] }>(
        API_ROUTES.agents.approvals,
      );
      return response.data.approvals;
    },
    // A new request arrives with a socket event; this is the backstop.
    refetchInterval: 60_000,
    // The approvals are the account's; signed out this would be a 401 a minute.
    enabled: isAuthenticated,
    select: (approvals) => approvals.filter((approval) => approvalInScope(approval, scope)),
  });
}

export function usePendingAgentApprovals(agentId?: string) {
  return useApprovals(agentId ? { agentId } : {});
}

/** The requests asked in one Alia conversation, by Alia or an agent in it. */
export function usePendingConversationApprovals(conversationId: string) {
  return useApprovals({ conversationId });
}

export function useDecideAgentApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      approved,
      hash,
    }: {
      id: string;
      approved: boolean;
      hash?: string;
    }) => {
      const response = await apiClient.post<{ status: string }>(
        API_ROUTES.agents.approvalDecision(id),
        { approved, ...(hash ? { hash } : {}) },
      );
      return response.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentApprovalsKey }),
  });
}
