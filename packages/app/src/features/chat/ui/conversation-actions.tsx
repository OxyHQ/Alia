import { buildConversationMarkdown, exportFilename } from '@gemies/sdk/model';
import type { GemieChatState } from '@gemies/sdk';
import { useDeleteConversation, useShareConversation } from '@gemies/sdk/runtime';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { deliverMarkdownFile, deliverShareLink } from '@/features/chat/runtime/conversation-share';
import { ChatHeaderActions } from '@/features/chat/ui/chat-header-actions';
import { queryKeys } from '@/shared/api/query-keys';
import { useTranslation } from '@/shared/i18n/use-translation';

interface ConversationActionsProps {
  /** What the chat tells its chrome: the open conversation and its messages. */
  chat: GemieChatState;
  /** Whether the conversation can be shared: a temporary (ghost) chat is never stored, so it cannot. */
  shareable?: boolean;
}

/** Whether Alia answered a request with this status (`GemieApiError.status`). */
const hasStatus = (error: unknown, status: number): boolean =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === status;

/**
 * The conversation's own actions in the breadcrumb row — search, share, export, clear and delete —
 * wired to the app: its router, its right panel, where an export goes and
 * how a share link is handed on.
 */
export function ConversationActions({ chat, shareable = true }: ConversationActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();
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
    const title = cached?.title?.trim() || t('chat.newChat');
    const exportedAt = new Date();
    const markdown = buildConversationMarkdown({
      title,
      messages: getMessages(),
      exportedAt,
      userLabel: t('chat.searchThreadYou'),
    });
    deliverMarkdownFile(exportFilename(title, exportedAt), markdown, title).catch(() => {
      toast.error(t('chat.exportFailed'));
    });
  }, [queryClient, conversationId, getMessages, t]);

  /**
   * Share the conversation: mint its read-only link (`POST /v1/conversations/:id/share`, 24 hours)
   * and hand `share.url` — Alia's one shared page, the same link every app's sheet mints — to the
   * platform's share sheet or the clipboard. Sharing again replaces the link, so an older one stops
   * working. What a reader sees is text, images and who said them, never a tool's output
   * (Gemies `docs/agent-embedding.md` §6).
   */
  const { share, revoke } = useShareConversation();
  const handleShare = useCallback(async () => {
    if (conversationId === undefined) return;
    let url: string;
    try {
      ({ url } = await share(conversationId));
    } catch {
      toast.error(t('chat.shareFailed'));
      return;
    }
    const cached = queryClient.getQueryData<{ title?: string }>(
      queryKeys.conversations.detail(conversationId),
    );
    const title = cached?.title?.trim() || t('chat.newChat');
    try {
      const outcome = await deliverShareLink(url, title, t('chatHeader.shareText'));
      if (outcome === 'copied') {
        toast.success(t('chatHeader.shareCopied'), {
          description: t('chatHeader.shareCopiedDescription'),
        });
      }
    } catch {
      toast.error(t('chatHeader.shareDeliverFailed'));
    }
  }, [share, conversationId, queryClient, t]);

  /** End the conversation's link: whoever holds it can no longer read the conversation. */
  const handleStopSharing = useCallback(async () => {
    if (conversationId === undefined) return;
    try {
      await revoke(conversationId);
      toast.success(t('chatHeader.sharingStopped'), {
        description: t('chatHeader.sharingStoppedDescription'),
      });
    } catch (error: unknown) {
      if (hasStatus(error, 404)) toast(t('chatHeader.notShared'));
      else toast.error(t('chatHeader.stopSharingFailed'));
    }
  }, [revoke, conversationId, t]);

  /**
   * Delete this conversation, once the person has confirmed it, and go home. A refusal is already
   * reported by the mutation's own toast.
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

  // What needs a stored conversation is offered once there is one.
  const stored = conversationId !== undefined;
  return (
    <ChatHeaderActions
      onSearch={stored ? openSearch : undefined}
      onShare={stored && shareable ? handleShare : undefined}
      onStopSharing={stored && shareable ? handleStopSharing : undefined}
      onExport={stored ? handleExport : undefined}
      onClear={stored ? clearMessages : undefined}
      onDelete={stored ? handleDelete : undefined}
    />
  );
}
