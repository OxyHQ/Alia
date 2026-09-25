import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';

/**
 * An action an agent working in the background asked this person to approve.
 *
 * The run that asked did not wait (`packages/api/src/lib/agent/deferred-approvals.ts`):
 * approving starts a new run that performs exactly this action, so the answer
 * can come minutes or days later, from here.
 */
export interface PendingAgentApproval {
  id: string;
  agentId: string;
  toolName: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export const agentApprovalsKey = ['agent-approvals'] as const;

export function usePendingAgentApprovals(agentId?: string) {
  return useQuery({
    queryKey: agentApprovalsKey,
    queryFn: async () => {
      const response = await apiClient.get<{ approvals: PendingAgentApproval[] }>(API_ROUTES.agents.approvals);
      return response.data.approvals;
    },
    // A new request arrives with the agent's message; this is the backstop.
    refetchInterval: 60_000,
    select: (approvals) => (agentId ? approvals.filter((a) => a.agentId === agentId) : approvals),
  });
}

export function useDecideAgentApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, approved }: { id: string; approved: boolean }) => {
      await apiClient.post(API_ROUTES.agents.approvalDecision(id), { approved });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentApprovalsKey }),
  });
}
