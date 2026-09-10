import { useEffect, useCallback, useRef } from "react";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useStore, type Attachment } from "@/lib/stores/global-store";
import { useStreamingChat, type SendOptions } from "@/lib/hooks/use-streaming-chat";
import { ConversationNotFoundError, useConversation, useCreateConversation, useDeleteConversation, type Message } from "@/lib/hooks/use-conversations";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { API_ROUTES } from "@/lib/api/routes";
import { buildMessageContent } from "@/lib/attachment-utils";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import type { EffortLevel } from '@/lib/hooks/use-catalogue';
import { toast } from "@oxy.so/bloom/toast";
import i18n from "@/lib/i18n";
import { getTextFromContent } from "@alia.onl/sdk/content";

interface UseChatConversationOptions {
  conversationId?: string;
  reasoningEffort?: EffortLevel | null;
  selectedModel?: string;
  agentId?: string;
}

type MessageContent = Message['content'];

/**
 * What an edit sends in place of the original user turn.
 *
 * A STRING is the composer's edit: it replaces the text of the turn and keeps
 * every non-text part (`image_url`, files) the turn already carried, because
 * the composer only ever shows the text for editing and a person rewording a
 * question about a picture has not asked for the picture to go. A full parts
 * ARRAY is sent verbatim — that is how regenerate replays a turn unchanged, and
 * how a caller that has deliberately removed an attachment says so.
 */
export type EditedContent = string | MessageContent;

/**
 * Merge an edit into the original turn's content, per the `EditedContent` rule.
 * The replacement text lands where the original's first text part was, so a
 * turn built as `[text, image]` stays `[text, image]` rather than reordering
 * the picture ahead of the question; an original with no text part (image-only)
 * gets the new text appended after its attachments.
 */
export function mergeEditedContent(original: MessageContent | undefined, edit: EditedContent): MessageContent {
  if (typeof edit !== 'string') return edit;
  if (!Array.isArray(original)) return edit;
  const attachments = original.filter((part) => part.type !== 'text');
  if (attachments.length === 0) return edit;
  if (!edit.trim()) return attachments;
  const textPart = { type: 'text', text: edit };
  const firstTextIndex = original.findIndex((part) => part.type === 'text');
  if (firstTextIndex < 0) return [...attachments, textPart];
  const before = original.slice(0, firstTextIndex).filter((part) => part.type !== 'text');
  const after = original.slice(firstTextIndex + 1).filter((part) => part.type !== 'text');
  return [...before, textPart, ...after];
}

/** True when there is nothing to send: no text and no attachment part. */
function isEmptyContent(content: MessageContent | undefined): boolean {
  if (content === undefined || content === null) return true;
  if (typeof content === 'string') return !content.trim();
  return content.length === 0;
}

export function useChatConversation({ conversationId, reasoningEffort, selectedModel, agentId }: UseChatConversationOptions = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const scrollViewRef = useRef<GHScrollView>(null);
  const hasSentPendingMessage = useRef(false);
  const lastConversationId = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);

  const pendingInitialMessage = useStore((state) => state.pendingInitialMessage);
  const {
    data: conversation,
    error: conversationQueryError,
    isLoading: conversationQueryLoading,
    isFetching: conversationFetching,
  } = useConversation(conversationId || "");
  const createConversationMutation = useCreateConversation();
  const { mutateAsync: deleteConversation } = useDeleteConversation();

  // A missing row is not a transient loading failure and the URL cannot become
  // useful by staying open. Remove its cached detail/list state and return to a
  // valid composer; the query itself has retries disabled, so this happens once.
  useEffect(() => {
    if (!(conversationQueryError instanceof ConversationNotFoundError)) return;
    queryClient.removeQueries({ queryKey: queryKeys.conversations.detail(conversationQueryError.conversationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
    useStore.getState().setChatId(null);
    router.replace("/(app)");
  }, [conversationQueryError, queryClient, router]);

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
    failedTurn,
    retryFailedTurn: retry,
    clearFailedTurn,
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
    // rollback. Only the usage-limit errors end here now; every other failure
    // is `errored` — the turn stays in the thread with its error and a retry,
    // and the composer stays clear because the text is already on screen.
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
    newContent: EditedContent,
    options?: SendOptions,
  ): Promise<boolean> => {
    // Truncate to messages before the edited one, then re-send.
    // setMessages eagerly syncs messagesRef so append reads truncated history.
    const beforeEdit = messages;
    const original = messages.find(msg => msg.id === messageId);
    // A string edit keeps the original turn's attachments; only a full parts
    // array replaces them. See `EditedContent`.
    const content = mergeEditedContent(original?.content, newContent);
    if (isEmptyContent(content)) return false;

    setMessages(prev => {
      const idx = prev.findIndex(msg => msg.id === messageId);
      return idx < 0 ? prev : prev.slice(0, idx);
    });

    const outcome = await append({ role: 'user', content }, options);

    // append rolls back to the truncated list; only this scope still knows what
    // was cut, so it restores the rest and returns the edit to the composer.
    // The original turn — attachments included — comes back with the rest, so
    // nothing the person attached is orphaned by a send that never happened;
    // the composer gets the text, which is the part it can show.
    if (outcome === 'failed') {
      setMessages(beforeEdit);
      useStore.getState().setComposerDraft({
        text: getTextFromContent(content),
        target: conversationId ?? null,
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      toast.error(i18n.t('chat.sendFailed'));
    }
    return outcome !== 'failed';
  }, [setMessages, append, messages, conversationId]);

  const regenerateMessage = useCallback(async (
    assistantMessageId: string,
    options?: SendOptions,
  ): Promise<boolean> => {
    // Regenerating IS re-sending the prompt that produced this answer. Walk back
    // to the user turn before it and replay that — editMessage already truncates
    // the history and re-appends, so there is no second path to keep in step.
    //
    // The turn goes through WHOLE: a string stays a string and a parts array
    // keeps its `image_url`/file parts. Reducing it to its text first is what
    // used to regenerate "what is in this picture" without the picture, and
    // refuse outright on a prompt that was only a picture.
    const idx = messages.findIndex(msg => msg.id === assistantMessageId);
    if (idx < 0) return false;
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (candidate.role !== 'user') continue;
      if (isEmptyContent(candidate.content)) return false;
      return editMessage(candidate.id, candidate.content, options);
    }
    return false;
  }, [messages, editMessage]);

  const stopGeneration = useCallback(() => {
    stop();
  }, [stop]);

  /**
   * Send the failed turn again. Guarded on `isLoading` like `sendMessage`:
   * the card is gone the moment a send starts, but a double tap can land
   * before that render.
   */
  const retryFailedTurn = useCallback(async (): Promise<boolean> => {
    if (isLoading) return false;
    useStore.getState().setBottomChatHeightHandler(true);
    const outcome = await retry();
    return outcome !== 'failed';
  }, [isLoading, retry]);

  const clearConversation = useCallback(() => {
    setMessages([]);
    // The message the error hung under is gone with the rest.
    clearFailedTurn();
  }, [setMessages, clearFailedTurn]);

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
    regenerateMessage,
    stopGeneration,
    clearConversation,
    clearError,
    setMessages,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    failedTurn,
    retryFailedTurn,
  };
}
