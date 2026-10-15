import { buildConversationMarkdown, exportFilename } from '@alia.onl/sdk/model';
import type { AliaChatState } from '@alia.onl/sdk';
import { useDeleteConversation } from '@alia.onl/sdk/runtime';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { deliverMarkdownFile } from '@/features/chat/runtime/conversation-share';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { ChatHeaderActions } from '@/features/chat/ui/chat-header-actions';
import { queryKeys } from '@/shared/api/query-keys';
import { useTranslation } from '@/shared/i18n/use-translation';

interface ConversationActionsProps {
  /** What the chat tells its chrome: the open conversation, its messages, whether it is a thread. */
  chat: AliaChatState;
  /** The agent's name, for the title when the chat has none. */
  agentName?: string;
  /** The agent this chat belongs to, when it does. */
  agentId?: string;
  /** The handle whose thread this is, when it is one. */
  threadHandle?: string;
}

/**
 * The conversation's own actions in the breadcrumb row — search, export, clear, delete and the
 * agent's terminal — wired to the app: its router, its right panel and where an export goes.
 */
export function ConversationActions({
  chat,
  agentName,
  agentId,
  threadHandle,
}: ConversationActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const { conversationId, getMessages, clearMessages, openSearch } = chat;

  /**
   * Export the conversation as a Markdown document. The title is read out of the query cache at
   * the moment of the export: the `alia.title` frame writes the generated title into the same key,
   * so this sees it without a subscription of its own.
   */
  const handleExport = useCallback(() => {
    if (conversationId === undefined) return;
    const cached = queryClient.getQueryData<{ title?: string }>(
      queryKeys.conversations.detail(conversationId),
    );
    const title = cached?.title?.trim() || agentName || t('chat.newChat');
    const exportedAt = new Date();
    const markdown = buildConversationMarkdown({
      title,
      messages: getMessages(),
      exportedAt,
      assistantName: agentName,
      userLabel: t('chat.searchThreadYou'),
    });
    deliverMarkdownFile(exportFilename(title, exportedAt), markdown, title).catch(() => {
      toast.error(t('chat.exportFailed'));
    });
  }, [queryClient, conversationId, getMessages, agentName, t]);

  /**
   * Delete this conversation, once the person has confirmed it, and go home.
   *
   * Only on `/c/:id`: an agent's thread is a view over several conversations, and deleting the one
   * on screen would quietly put the previous stretch in its place rather than remove "the chat".
   * A refusal is already reported by the mutation's own toast.
   */
  const deleteConversation = useDeleteConversation();
  const handleDelete = useCallback(async () => {
    if (conversationId === undefined) return;
    const ok = await confirm({
      title: t('chat.deleteConversationTitle'),
      description: t('chat.deleteConversationDescription'),
      confirmLabel: t('chat.deleteConversationConfirm'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteConversation.mutateAsync(conversationId);
      router.replace('/');
    } catch {
      // Reported by `useDeleteConversation`'s own error toast.
    }
  }, [t, deleteConversation, conversationId, router]);

  /**
   * The agent whose terminal this chat can show: the thread's own agent, or the one a turn of THIS
   * conversation put to work. The panel keeps it for the route it was opened on, so another chat
   * never shows it.
   */
  const workingAgentId = useUIStore((s) =>
    s.activeAgentConversationId === conversationId ? s.activeAgentId : null,
  );
  const terminalAgentId = agentId ?? workingAgentId ?? undefined;
  const handleOpenTerminal = useCallback(() => {
    if (terminalAgentId !== undefined)
      useUIStore.getState().openAgentTerminal(terminalAgentId, pathname);
  }, [terminalAgentId, pathname]);

  return (
    <ChatHeaderActions
      onSearch={openSearch}
      onExport={handleExport}
      onClear={clearMessages}
      onOpenTerminal={terminalAgentId === undefined ? undefined : handleOpenTerminal}
      onDelete={threadHandle === undefined ? handleDelete : undefined}
    />
  );
}
