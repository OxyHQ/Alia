import { agentEditRoute } from '@/shared/routing/agent-address';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * Open an agent's editor where the screen has room for it: the right panel beside the
 * conversation (as Bloom's multi-agent chat shows it) from the `md` breakpoint up, and its own
 * screen, `/@handle/edit`, on a phone — a panel there would be a drawer over the chat it edits.
 *
 * The handle is read from what the app already holds of the agent (its page or the person's own
 * list). An agent not held, or one with no handle, has no editor screen to go to.
 */
export function useOpenAgentEditor(): (agentId: string) => void {
  const router = useRouter();
  const isLargeScreen = useIsLargeScreen();
  const queryClient = useQueryClient();
  return useCallback(
    (agentId: string) => {
      if (isLargeScreen) {
        useUIStore.getState().openAgentEditor(agentId);
        return;
      }
      const known =
        queryClient.getQueryData<Agent>(queryKeys.agents.detail(agentId)) ??
        queryClient
          .getQueryData<Agent[]>(queryKeys.agents.mine)
          ?.find((agent) => agent._id === agentId);
      const route = agentEditRoute({ name: known?.name ?? null, handle: known?.handle ?? null });
      if (route !== null) router.push(route);
    },
    [isLargeScreen, router, queryClient],
  );
}
