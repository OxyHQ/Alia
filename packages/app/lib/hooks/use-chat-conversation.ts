import { useEffect, useCallback, useRef } from "react";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useStore, type Attachment } from "@/lib/stores/global-store";
import { useStreamingChat, type SendOptions } from "@/lib/hooks/use-streaming-chat";
import { useConversation, useCreateConversation, useDeleteConversation } from "@/lib/hooks/use-conversations";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { API_ROUTES } from "@/lib/api/routes";
import { buildMessageContent } from "@/lib/attachment-utils";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import type { EffortLevel } from '@/lib/hooks/use-catalogue';
import { toast } from "@oxyhq/bloom/toast";
import i18n from "@/lib/i18n";

interface UseChatConversationOptions {
  conversationId?: string;
  reasoningEffort?: EffortLevel | null;
  selectedModel?: string;
  agentId?: string;
}

export function useChatConversation({ conversationId, reasoningEffort, selectedModel, agentId }: UseChatConversationOptions = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const scrollViewRef = useRef<GHScrollView>(null);
  const hasSentPendingMessage = useRef(false);
  const lastConversationId = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);

  const pendingInitialMessage = useStore((state) => state.pendingInitialMessage);
  const { data: conversation, isLoading: conversationQueryLoading, isFetching: conversationFetching } = useConversation(conversationId || "");
  const createConversationMutation = useCreateConversation();
  const { mutateAsync: deleteConversation } = useDeleteConversation();

  /**
   * The product runtime, not the compatibility surface.
   *
   * `/alia/chat` and `/v1/chat/completions` are the same handler
   * (`packages/api/src/routes/chat.ts`), so the request and response shapes are
   * identical by construction — but ADR 0004 makes `/v1/*` a bounded-window
   * compatibility surface for EXTERNAL callers, and
   * `docs/migration/compatibility-window.md` gates its removal route by route on
   * first-party consumers having migrated. Naming the generic path here is what
   * made it canonical (epic #139 workstream 6). Two side effects, both wanted:
   * the app leaves the per-surface deprecation clock, and `/alia/chat` is the
   * mount that gets `setNoDelay` + `setTimeout(0)` for long SSE streams.
   *
   * ## The web build's origin, which this DOES narrow
   *
   * `/v1` is the only surface with wildcard CORS; every other route falls to the
   * Oxy allowlist in `packages/api/src/index.ts`. Native sends no `Origin` at
   * all and is unaffected. The web build is deployed to Cloudflare Pages project
   * `alia-app` (`.github/workflows/deploy-frontends.yml`), which serves it at
   * BOTH `https://alia.onl` and `https://alia-app.pages.dev`, and only the first
   * is on the allowlist.
   *
   * Measured 2026-08-19 before making this change: from
   * `https://alia-app.pages.dev`, `OPTIONS` against `/conversations`,
   * `/credits`, `/memory` and `/agents` all come back with no
   * `access-control-allow-origin`, while `https://alia.onl` is answered with a
   * match. So the app on that hostname already cannot list a conversation or
   * read a credit balance; chat was the last thing still working there, through
   * a CORS policy meant for external developers. This aligns it with the rest of
   * the app rather than breaking something that worked.
   */
  const {
    messages,
    append,
    isLoading,
    error,
    clearError,
    setMessages,
    stop,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
  } = useStreamingChat(generateAPIUrl(API_ROUTES.chat.alia), conversationId, reasoningEffort, selectedModel, agentId);

  // Expose streaming state globally so sidebar can show a spinner
  const setStreamingChatId = useStore((s) => s.setStreamingChatId);
  useEffect(() => {
    setStreamingChatId(isLoading && conversationId ? conversationId : null);
    return () => {
      if (useStore.getState().streamingChatId === conversationId) {
        setStreamingChatId(null);
      }
    };
  }, [isLoading, conversationId, setStreamingChatId]);

  // Refresh sidebar when streaming finishes (backend auto-saves with AI-generated title)
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && conversationId) {
      // Immediate refetch (gets saved conversation data)
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(conversationId) });
      // Delayed fallback for async title generation. Only the list needs it —
      // re-fetching the whole message detail 5s after every exchange just for
      // a possible title was a second full refetch per message.
      const timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      }, 5000);
      wasLoadingRef.current = isLoading;
      return () => clearTimeout(timer);
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, conversationId, queryClient]);

  // Sync chatId and load messages when conversation changes or when
  // seeded cache data upgrades to full data (messages go from empty to populated).
  useEffect(() => {
    useStore.getState().setChatId(conversationId ? { id: conversationId, from: "url" } : null);

    if (!conversationId || conversationQueryLoading) return;

    const incomingMessages = conversation?.messages || [];
    const isNewConversation = lastConversationId.current !== conversationId;
    const isDataUpgrade = !isNewConversation && incomingMessages.length > 0 && messages.length === 0;

    if (!isNewConversation && !isDataUpgrade) return;

    if (isNewConversation) {
      lastConversationId.current = conversationId;
      hasSentPendingMessage.current = false;
    }

    const validMessages = incomingMessages
      .filter(msg => msg?.role && msg?.content !== undefined)
      .map((msg, index) => ({
        ...msg,
        id: msg.id || `db-${conversationId}-${index}`,
      }));
    setMessages(validMessages);
  }, [conversationId, conversation, conversationQueryLoading, setMessages, messages.length]);

  // Send pending initial message for new conversations
  useEffect(() => {
    if (!conversationId || !pendingInitialMessage || isLoading) return;
    if (hasSentPendingMessage.current) return;
    if (messages.length > 0) return; // Only send if no messages yet

    const pending = pendingInitialMessage;
    hasSentPendingMessage.current = true;
    useStore.getState().setBottomChatHeightHandler(true);
    useStore.getState().clearPendingInitialMessage();

    void append(
      { role: 'user', content: pending.content },
      { mcpServerId: pending.mcpServerId, skillNames: pending.skillNames },
    ).then(async (outcome) => {
      if (outcome !== 'failed') return;

      // The conversation was created by POST /conversations/new before the model
      // was ever reached, and this guard ran on messages.length === 0, so the row
      // is provably empty. Undo it rather than leave a blank chat in the sidebar.
      // A failed delete still leaves the user whole — it only leaves the row.
      await deleteConversation(conversationId).catch(() => {});
      useStore.getState().setAttachments(pending.attachments);
      useStore.getState().setComposerDraft({
        text: pending.text,
        target: null,
        mcpServerId: pending.mcpServerId,
        skillNames: pending.skillNames,
      });
      router.replace("/(app)");
      toast.error(i18n.t('chat.sendFailed'));
    });
  }, [conversationId, pendingInitialMessage, isLoading, messages.length, append, deleteConversation, router]);

  // Actions
  const sendMessage = useCallback(async (
    content: string,
    attachments?: Attachment[],
    options?: SendOptions,
  ): Promise<boolean> => {
    if ((!content.trim() && !attachments?.length) || isLoading) return false;

    useStore.getState().setBottomChatHeightHandler(true);

    const messageContent = attachments?.length
      ? await buildMessageContent(content, attachments)
      : content;

    useStore.getState().clearAttachments();

    const outcome = await append(
      { role: 'user', content: messageContent },
      options,
    );

    // Nothing was persisted server-side (a turn without an assistant response is
    // never saved), so returning the composer to its pre-send state is the whole
    // rollback.
    if (outcome === 'failed') {
      useStore.getState().setAttachments(attachments ?? []);
      useStore.getState().setComposerDraft({
        text: content,
        target: conversationId ?? null,
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      toast.error(i18n.t('chat.sendFailed'));
    }
    return outcome !== 'failed';
  }, [isLoading, append, conversationId]);

  const createNewConversation = useCallback(async (
    initialMessage: string,
    attachments?: Attachment[],
    options?: SendOptions,
  ): Promise<boolean> => {
    if (!initialMessage.trim() && !attachments?.length) return false;

    // If there are attachments, build multi-part content and store it as pending.
    // The raw text and attachments ride along so a failed send can restore them.
    const pendingAttachments = attachments ?? [];
    const content = pendingAttachments.length
      ? await buildMessageContent(initialMessage, pendingAttachments)
      : initialMessage;
    useStore.getState().setPendingInitialMessage({
      content,
      text: initialMessage,
      attachments: pendingAttachments,
      mcpServerId: options?.mcpServerId ?? null,
      skillNames: options?.skillNames ?? [],
    });
    useStore.getState().clearAttachments();

    try {
      // Create conversation on backend and get the ID
      const newConversation = await createConversationMutation.mutateAsync({ agentId });

      // Navigate to the new conversation
      router.replace({ pathname: "/(app)/c/[id]", params: { id: newConversation.id } });
      return true;
    } catch {
      // useCreateConversation.onError already shows the toast. Drop the queued
      // message — left behind it auto-fires into the next empty conversation the
      // user opens — and hand the composer back what it was holding.
      useStore.getState().clearPendingInitialMessage();
      useStore.getState().setAttachments(pendingAttachments);
      useStore.getState().setComposerDraft({
        text: initialMessage,
        target: null,
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      return false;
    }
  }, [router, createConversationMutation, agentId]);

  const editMessage = useCallback(async (
    messageId: string,
    newContent: string,
    options?: SendOptions,
  ): Promise<boolean> => {
    // Truncate to messages before the edited one, then re-send.
    // setMessages eagerly syncs messagesRef so append reads truncated history.
    const beforeEdit = messages;
    setMessages(prev => {
      const idx = prev.findIndex(msg => msg.id === messageId);
      return idx < 0 ? prev : prev.slice(0, idx);
    });

    const outcome = await append({ role: 'user', content: newContent }, options);

    // append rolls back to the truncated list; only this scope still knows what
    // was cut, so it restores the rest and returns the edit to the composer.
    if (outcome === 'failed') {
      setMessages(beforeEdit);
      useStore.getState().setComposerDraft({
        text: newContent,
        target: conversationId ?? null,
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      toast.error(i18n.t('chat.sendFailed'));
    }
    return outcome !== 'failed';
  }, [setMessages, append, messages, conversationId]);

  const stopGeneration = useCallback(() => {
    stop();
  }, [stop]);

  const clearConversation = useCallback(() => {
    setMessages([]);
  }, [setMessages]);

  // True while loading conversation messages (initial fetch or seeded→full upgrade)
  const conversationLoading = conversationQueryLoading ||
    (conversationFetching && (!conversation?.messages || conversation.messages.length === 0));

  return {
    // State
    conversationId,
    messages,
    isLoading,
    conversationLoading,
    error,
    scrollViewRef,

    // Actions
    sendMessage,
    createNewConversation,
    editMessage,
    stopGeneration,
    clearConversation,
    clearError,
    setMessages,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
  };
}
