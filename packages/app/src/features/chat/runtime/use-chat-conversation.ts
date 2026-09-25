import { useEffect, useCallback, useRef } from "react";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/query-keys";
import { useStore, type Attachment } from "@/features/chat/runtime/global-store";
import { releaseAttachments, useComposerDraftStore } from "@/features/chat/runtime/composer-draft-store";
import { useStreamingChat, type SendOptions } from "@/features/chat/runtime/use-streaming-chat";
import { ConversationNotFoundError, useClearConversation, useConversation, useCreateConversation, useDeleteConversation, type Message } from "@/features/chat/runtime/use-conversations";
import { generateAPIUrl } from "@/shared/api/generate-api-url";
import { API_ROUTES } from "@/shared/api/routes";
import { buildMessageContent, type DroppedAttachment } from "@/features/chat/model/attachment-utils";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import type { EffortLevel } from '@/features/chat/runtime/use-catalogue';
import { toast } from "@oxy.so/bloom/toast";
import i18n from "@/shared/i18n";
import { getTextFromContent } from "@alia.onl/sdk/content";
import { acquireNotificationsSocket } from "@/features/notifications/runtime/notifications-socket";

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

/**
 * Say which attachments the turn went without.
 *
 * `buildMessageContent` used to drop them in silence: a document was filtered
 * out by `a.type === 'image'`, and an image whose bytes would not read was a
 * bare `continue`. The composer had already shown both as attached, so the
 * turn left with the person believing the file went with it — the visible
 * state and the real capability disagreeing, which is the failure #608 §1.6
 * names.
 *
 * A toast rather than a blocked send: the message itself is fine and worth
 * sending, and refusing the whole turn over a file the format cannot carry
 * would be a worse trade. What matters is that nobody finds out by noticing
 * the answer ignored their PDF.
 */
export function reportDroppedAttachments(dropped: DroppedAttachment[] | undefined): void {
  if (dropped === undefined || dropped.length === 0) return;

  for (const attachment of dropped) {
    toast.error(
      i18n.t(
        attachment.reason === 'unsupported'
          ? 'composer.attachmentNotSent'
          : 'composer.attachmentUnreadable',
        { name: attachment.name },
      ),
    );
  }
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
  const { mutateAsync: clearMessages } = useClearConversation();

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
    turnOptionsOf,
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

  // An agent wrote into THIS conversation on its own (a result, a check-in).
  // Appended to what is on screen: the detail refetch alone would not reach an
  // open chat, whose local messages are only replaced when the id changes. The
  // server keeps it even if the next turn is sent before this arrives.
  useEffect(() => {
    if (!conversationId) return;
    const { socket, release } = acquireNotificationsSocket();
    const onConversationMessage = (event: { conversationId?: string; message?: Message }) => {
      const incoming = event.message;
      if (event.conversationId !== conversationId || !incoming?.id) return;
      setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    };
    socket.on('conversation:message', onConversationMessage);
    return () => {
      socket.off('conversation:message', onConversationMessage);
      release();
    };
  }, [conversationId, setMessages]);

  // Send pending initial message for new conversations
  useEffect(() => {
    if (!conversationId || !pendingInitialMessage || isLoading) return;
    if (hasSentPendingMessage.current) return;
    if (messages.length > 0) return; // Only send if no messages yet

    const pending = pendingInitialMessage;
    // Taken now: a failure is handed back to the account that sent it, never
    // to one signed in while the request was out.
    const newChatDraft = useComposerDraftStore.getState().address(null);
    hasSentPendingMessage.current = true;
    useStore.getState().setBottomChatHeightHandler(true);
    useStore.getState().clearPendingInitialMessage();

    void append(
      { role: 'user', content: pending.content },
      { mcpServerId: pending.mcpServerId, skillNames: pending.skillNames },
    ).then(async (outcome) => {
      // The request carries the bytes inline now; the temporary URLs behind
      // the tiles have nothing left to show.
      if (outcome !== 'failed') {
        releaseAttachments(pending.attachments);
        return;
      }

      // The conversation was created by POST /conversations/new before the model
      // was ever reached, and this guard ran on messages.length === 0, so the row
      // is provably empty. Undo it rather than leave a blank chat in the sidebar.
      // A failed delete still leaves the user whole — it only leaves the row.
      await deleteConversation(conversationId).catch(() => {});
      useComposerDraftStore.getState().restore(newChatDraft, {
        text: pending.text,
        attachments: pending.attachments,
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
    const draft = useComposerDraftStore.getState().address(conversationId ?? null);

    useStore.getState().setBottomChatHeightHandler(true);

    const built = attachments?.length
      ? await buildMessageContent(content, attachments)
      : null;
    const messageContent = built ? built.content : content;
    reportDroppedAttachments(built?.dropped);

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
      useComposerDraftStore.getState().restore(draft, {
        text: content,
        attachments: attachments ?? [],
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      toast.error(i18n.t('chat.sendFailed'));
      return false;
    }
    // A retry re-sends the built content, whose bytes are inline.
    releaseAttachments(attachments ?? []);
    return true;
  }, [isLoading, append, conversationId]);

  const createNewConversation = useCallback(async (
    initialMessage: string,
    attachments?: Attachment[],
    options?: SendOptions,
  ): Promise<boolean> => {
    if (!initialMessage.trim() && !attachments?.length) return false;
    const draft = useComposerDraftStore.getState().address(null);

    // If there are attachments, build multi-part content and store it as pending.
    // The raw text and attachments ride along so a failed send can restore them.
    const pendingAttachments = attachments ?? [];
    const built = pendingAttachments.length
      ? await buildMessageContent(initialMessage, pendingAttachments)
      : null;
    const content = built ? built.content : initialMessage;
    reportDroppedAttachments(built?.dropped);
    useStore.getState().setPendingInitialMessage({
      content,
      text: initialMessage,
      attachments: pendingAttachments,
      mcpServerId: options?.mcpServerId ?? null,
      skillNames: options?.skillNames ?? [],
    });

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
      useComposerDraftStore.getState().restore(draft, {
        text: initialMessage,
        attachments: pendingAttachments,
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      return false;
    }
  }, [router, createConversationMutation, agentId]);

  /**
   * Rewrite a user turn: cut the thread back to it and send the new version.
   *
   * `attachments` are the ones added in the composer while editing. They go
   * AFTER whatever the turn already carried — a string edit keeps those, see
   * `EditedContent` — so rewording a question and adding a second picture is
   * one edit, not a lost picture.
   */
  const editMessage = useCallback(async (
    messageId: string,
    newContent: EditedContent,
    options?: SendOptions,
    attachments?: Attachment[],
  ): Promise<boolean> => {
    // Truncate to messages before the edited one, then re-send.
    // setMessages eagerly syncs messagesRef so append reads truncated history.
    const beforeEdit = messages;
    const draft = useComposerDraftStore.getState().address(conversationId ?? null);
    const original = messages.find(msg => msg.id === messageId);
    if (original === undefined) return false;
    // A string edit keeps the original turn's attachments; only a full parts
    // array replaces them. See `EditedContent`.
    let content = mergeEditedContent(original.content, newContent);
    if (attachments?.length && typeof newContent === 'string') {
      const built = await buildMessageContent(newContent, attachments);
      reportDroppedAttachments(built.dropped);
      const added = typeof built.content === 'string'
        ? []
        : built.content.filter((part) => part.type !== 'text');
      if (added.length > 0) {
        content = [
          ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content),
          ...added,
        ];
      }
    }
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
    // the composer gets the text, and the attachments added while editing.
    if (outcome === 'failed') {
      setMessages(beforeEdit);
      useComposerDraftStore.getState().restore(draft, {
        text: typeof newContent === 'string' ? newContent : getTextFromContent(content),
        attachments: attachments ?? [],
        mcpServerId: options?.mcpServerId ?? null,
        skillNames: options?.skillNames ?? [],
      });
      toast.error(i18n.t('chat.sendFailed'));
      return false;
    }
    releaseAttachments(attachments ?? []);
    return true;
  }, [setMessages, append, messages, conversationId]);

  /** The user turn a reply answers: the nearest one before it, or `undefined`. */
  const promptOf = useCallback((assistantMessageId: string): Message | undefined => {
    const idx = messages.findIndex(msg => msg.id === assistantMessageId);
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return undefined;
  }, [messages]);

  /**
   * Ask for this reply again, with the options its prompt was sent with.
   *
   * `fallback` is for a prompt this screen did not send (the conversation was
   * reloaded since): nothing records what it carried, so the caller's current
   * choice — the composer's — is the best there is.
   */
  const regenerateMessage = useCallback(async (
    assistantMessageId: string,
    fallback?: SendOptions,
  ): Promise<boolean> => {
    // Regenerating IS re-sending the prompt that produced this answer. Walk back
    // to the user turn before it and replay that — editMessage already truncates
    // the history and re-appends, so there is no second path to keep in step.
    //
    // The turn goes through WHOLE: a string stays a string and a parts array
    // keeps its `image_url`/file parts. Reducing it to its text first is what
    // used to regenerate "what is in this picture" without the picture, and
    // refuse outright on a prompt that was only a picture.
    const prompt = promptOf(assistantMessageId);
    if (prompt === undefined || isEmptyContent(prompt.content)) return false;
    return editMessage(prompt.id, prompt.content, turnOptionsOf(prompt.id) ?? fallback);
  }, [promptOf, editMessage, turnOptionsOf]);

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

  /**
   * Empty the thread — on the server first, then on screen.
   *
   * The order is the fix for #553. `setMessages([])` alone cleared the screen
   * and nothing else, and the sync effect above, seeing a cached history and
   * no messages, read that as a data upgrade and hydrated it straight back
   * under a dialog that had just promised the action could not be undone.
   * `useClearConversation` empties the cache in its `onSuccess`, which has run
   * by the time `mutateAsync` resolves, so the local reset that follows has
   * nothing left to be undone by.
   *
   * A turn still streaming is stopped first rather than refused: the person
   * has just confirmed they want the thread empty, and an answer that kept
   * arriving into it would be the next thing to clear. Stopping settles the
   * assistant placeholder as `cancelled` and lets the server close the turn,
   * so the clear that follows is of a thread nothing is writing to.
   *
   * A refusal keeps everything: the screen is not reset, the cache is not
   * touched, and the error is surfaced — a cleared view whose history returns
   * on the next fetch is exactly the state this exists to end.
   *
   * With no conversation id there is nothing persisted to clear, so the
   * screen's own list is all there is and the local reset is the whole job.
   */
  const clearConversation = useCallback(async (): Promise<boolean> => {
    if (isLoading) stop();

    if (conversationId) {
      try {
        await clearMessages(conversationId);
      } catch {
        toast.error(i18n.t('chatHeader.clearFailed'));
        return false;
      }
    }

    setMessages([]);
    // The message the error hung under is gone with the rest.
    clearFailedTurn();
    return true;
  }, [isLoading, stop, conversationId, clearMessages, setMessages, clearFailedTurn]);

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
    promptOf,
    turnOptionsOf,
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
