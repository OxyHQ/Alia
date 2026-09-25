import { agentChatRoute, agentDisplayName, agentHandle } from '@/features/agents/model/identity';
import {
  errorResponseData,
  errorStatus,
  errorMessage as getErrorMessage,
} from '@/shared/api/error-utils';
import {
  useSetAgentStatus,
  useStartAgentTask,
} from '@/features/agents/runtime/use-agent-thread-actions';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Share } from 'react-native';

/** Alia's web origin, where every app route is also a page. */
const WEB_ORIGIN = 'https://alia.onl';

/**
 * The text "Share" hands the system sheet: who the agent is and its page.
 *
 * The link pointed at `alia.app`, which is not Alia's domain, so every shared
 * agent was a dead link. And `agent.name` is nullable (Oxy's lookup fails
 * open), which printed "null — …"; the display name never is.
 */
export function agentShareMessage(
  agent: Pick<Agent, '_id' | 'name' | 'handle' | 'tagline'>,
): string {
  const who = agent.tagline
    ? `${agentDisplayName(agent)} — ${agent.tagline}`
    : agentDisplayName(agent);
  return `${who}\n${WEB_ORIGIN}/agents/${agent._id}`;
}

/**
 * What the agent screen's buttons do: open a thread, start a task, share the
 * agent, pause or resume it.
 *
 * Every write goes through a mutation in `use-agent-thread-actions.ts`; what
 * lives here is the answer to each outcome — where to navigate, what to toast.
 */
export function useAgentDetailActions(agent: Agent) {
  const router = useRouter();
  const { t } = useTranslation();
  const startTask = useStartAgentTask();
  const setStatus = useSetAgentStatus();

  const [showHireInput, setShowHireInput] = useState(false);
  const [taskInput, setTaskInput] = useState('');
  const [hiring, setHiring] = useState(false);

  /** The thread with this agent, addressed by its handle. */
  const openThread = useCallback(
    (handle: string, threadId: string) => {
      router.push({
        pathname: '/(app)/[username]',
        params: { username: `@${handle}`, threadId },
      });
    },
    [router],
  );

  /**
   * Open the thread with this agent. It does not START one.
   *
   * The thread is the agent's handle: `/@handle` opens it where it left off,
   * and the API begins its first conversation only when the two have never
   * spoken (`GET /agents/thread/:username`). That is what the Agents list's
   * own Chat button does (`agentChatRoute`), and this one now does the same.
   *
   * It used to POST a new thread and land on it — two wrongs at once. A new
   * thread is a new STRETCH, and somebody pressing "Chat" is asking to
   * continue; every press left an empty one behind. And on a phone the press
   * did nothing visible at all while the request was out (#608, Pixel 8a,
   * `docs/native-validation.mdx`), so it was pressed again.
   *
   * Without a handle the thread has no address; saying so is better than
   * navigating to `/@`, which would sit on a loading screen that never
   * resolves.
   */
  const handleChat = useCallback(() => {
    if (agentHandle(agent) === '') {
      toast.error(t('agents.chatUnavailable'));
      return;
    }
    router.push(agentChatRoute(agent));
  }, [agent, router, t]);

  const handleHirePress = () => {
    if (agent.status !== 'active') {
      toast.error(t('agents.notActive'));
      return;
    }
    setShowHireInput(true);
  };

  const handleHireSubmit = useCallback(async () => {
    if (!taskInput.trim() || hiring) return;
    setHiring(true);
    try {
      const { threadId, sessionId } = await startTask.mutateAsync({
        agentId: agent._id,
        objective: taskInput.trim(),
      });
      setTaskInput('');
      setShowHireInput(false);
      toast.success(t('agents.taskStarted'));

      const handle = agentHandle(agent);
      if (handle) openThread(handle, threadId);

      // Open agent panel if session was created
      if (sessionId) {
        const { useUIStore } = await import('@/features/chat/runtime/ui-store');
        useUIStore.getState().openAgentPanel(sessionId, agent._id);
      }
    } catch (err: unknown) {
      const status = errorStatus(err);
      const data = errorResponseData(err);
      if (status === 402) {
        toast.error(
          data?.creditsNeeded
            ? t('agents.insufficientCreditsCount', { count: data.creditsNeeded })
            : t('agents.insufficientCredits'),
        );
        // Open credits panel
        const { useUIStore } = await import('@/features/chat/runtime/ui-store');
        useUIStore.getState().setRightPanel('credits');
      } else if (status === 503) {
        toast.error(t('agents.infrastructureUnavailable'));
      } else {
        // Through the extractor, not off the body: `/v1` answers
        // `{ error: { message, type } }`, and handing that object to `toast`
        // is the same React #31 crash deleting a show produced.
        toast.error(getErrorMessage(err, t('agents.taskStartFailed')));
      }
    } finally {
      setHiring(false);
    }
  }, [agent, taskInput, hiring, startTask.mutateAsync, openThread, t]);

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

  return {
    handleChat,
    handleHirePress,
    handleHireSubmit,
    handleShare,
    handleStatusToggle,
    openThread,
    showHireInput,
    taskInput,
    setTaskInput,
    hiring,
  };
}
