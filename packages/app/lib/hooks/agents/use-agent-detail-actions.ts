import { agentDisplayName, agentHandle } from '@/lib/agents/identity';
import {
  errorResponseData,
  errorStatus,
  errorMessage as getErrorMessage,
} from '@/lib/errors/error-utils';
import {
  useCreateAgentThread,
  useSetAgentStatus,
  useStartAgentTask,
} from '@/lib/hooks/agents/use-agent-thread-actions';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { Agent } from '@/lib/types/agents';
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
  const createThread = useCreateAgentThread();
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
   * This used to create a conversation and land on `/c/:id`, which was two
   * wrongs at once. A thread with an agent is many ordinary conversations, so
   * creating one is beginning a NEW STRETCH — and somebody pressing a button
   * labelled "Chat" is asking to continue, not to begin. Every press left an
   * empty stretch behind; five presses, five empty rows.
   *
   * Beginning one is a separate act with its own places: the agent can offer it
   * mid-thread, and a person can take that offer. Neither of them is this
   * button.
   *
   * The address is the HANDLE, which is Oxy's and may be unresolved — the thread
   * has no address without one. Saying so is better than navigating to `/@`,
   * which would sit on a loading screen that never resolves.
   */
  const handleChat = useCallback(async () => {
    const handle = agentHandle(agent);
    if (handle === '') {
      toast.error(t('agents.chatUnavailable'));
      return;
    }
    try {
      const threadId = await createThread.mutateAsync({
        agentId: agent._id,
        title: t('agents.chatWithTitle', { name: agentDisplayName(agent) }),
      });
      openThread(handle, threadId);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('agents.threadCreateFailed')));
    }
  }, [agent, createThread.mutateAsync, openThread, t]);

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
        const { useUIStore } = await import('@/lib/stores/ui-store');
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
        const { useUIStore } = await import('@/lib/stores/ui-store');
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
