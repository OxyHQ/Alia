import { useDeleteAgent, useUpdateAgent } from '@/lib/hooks/use-agents';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { Agent } from '@/lib/types/agents';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

/**
 * The editor's two whole-agent actions: publish or unpublish it, and delete it.
 *
 * `isPublished` is held here rather than read off the query because the toggle
 * is optimistic — it flips before the write lands and flips back if the write
 * is refused.
 */
export function useAgentEditorActions(agent: Agent) {
  const router = useRouter();
  const { t } = useTranslation();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();
  const [isPublished, setIsPublished] = useState(agent.isPublished);

  const togglePublished = useCallback(async () => {
    const newValue = !isPublished;
    setIsPublished(newValue);
    try {
      await updateAgent.mutateAsync({
        id: agent._id,
        updates: { isPublished: newValue },
      });
      toast.success(newValue ? t('agents.published') : t('agents.draft'));
    } catch {
      setIsPublished(!newValue);
      toast.error(t('agents.publishFailed'));
    }
  }, [agent._id, isPublished, updateAgent.mutateAsync, t]);

  const deleteWithConfirm = useCallback(async () => {
    const ok = await confirm({
      title: t('agents.deleteAgent'),
      description: t('agents.deleteAgentConfirm'),
      confirmLabel: t('agents.deleteAgent'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgent.mutateAsync(agent._id);
      toast.success(t('agents.agentDeleted'));
      router.back();
    } catch {
      toast.error(t('agents.deleteFailed'));
    }
  }, [agent._id, deleteAgent.mutateAsync, router, t]);

  return { isPublished, togglePublished, deleteWithConfirm };
}
