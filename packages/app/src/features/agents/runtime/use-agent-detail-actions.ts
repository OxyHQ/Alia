import { WEB_ORIGIN } from '@/shared/platform/web-origin';
import { agentDisplayName } from '@/features/agents/model/identity';
import { agentChatRoute, agentDetailsRoute, agentThreadHref } from '@/shared/routing/agent-address';
import { useSetAgentStatus } from '@/features/agents/runtime/use-agent-thread-actions';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Share } from 'react-native';

/**
 * The text "Share" hands the system sheet: who the agent is and its page.
 *
 * The link pointed at `alia.app`, which is not Alia's domain, so every shared
 * agent was a dead link. And `agent.name` is nullable (Oxy's lookup fails
 * open), which printed "null — …"; the display name never is. An agent with no handle has no page
 * to link to, so it is shared by who it is alone.
 */
export function agentShareMessage(
  agent: Pick<Agent, '_id' | 'name' | 'handle' | 'tagline'>,
): string {
  const who = agent.tagline
    ? `${agentDisplayName(agent)} — ${agent.tagline}`
    : agentDisplayName(agent);
  const page = agentDetailsRoute(agent);
  return page === null ? who : `${who}\n${WEB_ORIGIN}${page}`;
}

/**
 * What the agent screen's buttons do: open a thread, share the agent, pause or resume it.
 *
 * Every write goes through a mutation in `use-agent-thread-actions.ts`; what
 * lives here is the answer to each outcome — where to navigate, what to toast.
 */
export function useAgentDetailActions(agent: Agent) {
  const router = useRouter();
  const { t } = useTranslation();
  const setStatus = useSetAgentStatus();

  /** The thread with this agent, addressed by its handle. */
  const openThread = useCallback(
    (handle: string, threadId: string) => {
      router.push(agentThreadHref(handle, threadId));
    },
    [router],
  );

  /**
   * Open the thread with this agent. It does not START one.
   *
   * The thread is the agent's handle: `/@handle` opens it where it left off, and the API begins its
   * first conversation only when the two have never spoken (`GET /agents/thread/:username`).
   * Without a handle the thread has no address; saying so is better than navigating to `/@`, which
   * would sit on a loading screen that never resolves.
   */
  const handleChat = useCallback(() => {
    const route = agentChatRoute(agent);
    if (route === null) {
      toast.error(t('agents.chatUnavailable'));
      return;
    }
    router.push(route);
  }, [agent, router, t]);

  const handleShare = async () => {
    try {
      await Share.share({
        message: agentShareMessage(agent),
      });
    } catch {
      // user cancelled — no action needed
    }
  };

  const handleStatusToggle = async (newStatus: 'active' | 'idle') => {
    try {
      await setStatus.mutateAsync({ agentId: agent._id, status: newStatus });
    } catch {
      toast.error(t('agents.statusUpdateFailed'));
    }
  };

  return { handleChat, handleShare, handleStatusToggle, openThread };
}
