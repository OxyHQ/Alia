import type { AgentThreadSummary as AgentThread } from '@/lib/hooks/use-agent-threads';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** The caller's latest threads with the agent; nothing at all when there are none. */
export function AgentThreadsList({
  threads,
  onOpen,
}: {
  threads: readonly AgentThread[];
  onOpen: (thread: AgentThread) => void;
}) {
  const { t } = useTranslation();
  if (threads.length === 0) return null;

  return (
    <SettingsListGroup title={t('agents.threads')}>
      {threads.slice(0, 8).map((thread) => (
        <SettingsListItem
          key={thread.id}
          title={thread.title}
          titleNumberOfLines={1}
          description={`${thread.executionTarget === 'cowork' ? 'Cowork' : t('agents.threadSandbox')} · ${t(thread.status === 'open' ? 'agents.threadOpen' : 'agents.threadClosed')}`}
          value={formatRelativeTime(thread.updatedAt)}
          onPress={() => onOpen(thread)}
        />
      ))}
    </SettingsListGroup>
  );
}
