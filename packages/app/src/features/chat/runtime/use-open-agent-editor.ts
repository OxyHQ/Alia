import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * Open an agent's editor where the screen has room for it: the right panel beside the
 * conversation (as Bloom's multi-agent chat shows it) from the `md` breakpoint up, and its own
 * screen, `/agents/edit/:id`, on a phone — a panel there would be a drawer over the chat it edits.
 */
export function useOpenAgentEditor(): (agentId: string) => void {
  const router = useRouter();
  const isLargeScreen = useIsLargeScreen();
  return useCallback(
    (agentId: string) => {
      if (isLargeScreen) useUIStore.getState().openAgentEditor(agentId);
      else router.push({ pathname: '/(app)/agents/edit/[id]', params: { id: agentId } });
    },
    [isLargeScreen, router],
  );
}
