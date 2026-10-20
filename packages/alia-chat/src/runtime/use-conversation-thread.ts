import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useAliaActivityStore } from '../lib/activity-store';
import { turnActivityState } from '../lib/turn-state';
import { useLabels } from '../lib/labels';
import { getTextFromContent } from '../lib/content-utils';
import type { AliaAttachment } from '../types';
import { buildMessageContent } from './attachment-utils';
import type { AliaHostTools } from './host-tools';
import { useDocumentUpload } from './oxy-files';
import { useAliaRuntime } from './config';
import { releaseAttachments, useComposerDraftStore } from './composer-draft-store';
import { useConversationStore } from './conversation-store';
import {
  ConversationNotFoundError,
  useClearConversation,
  useConversation,
  useCreateConversation,
  useDeleteConversation,
} from './conversations';
import { aliaQueryKeys } from './query-keys';
import { reportDroppedAttachments, useStartConversation } from './use-start-conversation';
import { useConversationStream } from './use-conversation-stream';
import type { Message, SendOptions } from './types';

export interface UseConversationThreadOptions {
  conversationId?: string;
  /** The power level (or device model) every turn is sent with. */
  model?: string;
  agentId?: string;
  /** What the host app is; see `useConversationStream`. */
  clientContext?: string;
  /** The UI effects the host performs; see `useConversationStream`. */
  hostTools?: AliaHostTools;
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
export function mergeEditedContent(
  original: MessageContent | undefined,
  edit: EditedContent,
): MessageContent {
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

export function useConversationThread({
  conversationId,
  model,
  agentId,
  clientContext,
  hostTools,
}: UseConversationThreadOptions = {}) {
  const queryClient = useQueryClient();
  const labels = useLabels();
  const { host } = useAliaRuntime();
  const { user } = useOxy();
  const bindDraftAccount = useComposerDraftStore((state) => state.bindAccount);
  // The drafts are this account's: a different person starts with none.
  useEffect(() => bindDraftAccount(user?.id ?? null), [bindDraftAccount, user?.id]);
  const hasSentPendingMessage = useRef(false);
  const lastConversationId = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);

  const pendingInitialMessage = useConversationStore((state) => state.pendingInitialMessage);
  const {
    data: conversation,
    error: conversationQueryError,
    isLoading: conversationQueryLoading,
    isFetching: conversationFetching,
  } = useConversation(conversationId || '');
  const createConversationMutation = useCreateConversation();
  const { mutateAsync: deleteConversation } = useDeleteConversation();
  const { mutateAsync: clearMessages } = useClearConversation();

  // A missing row is not a transient loading failure and the URL cannot become
  // useful by staying open. Remove its cached detail/list state and return to a
  // valid composer; the query itself has retries disabled, so this happens once.
  useEffect(() => {
    if (!(conversationQueryError instanceof ConversationNotFoundError)) return;
    queryClient.removeQueries({
      queryKey: aliaQueryKeys.conversations.detail(conversationQueryError.conversationId),
    });
    void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.all });
    host.closeConversation?.();
  }, [conversationQueryError, queryClient, host]);

  /**
   * Turns go to `/v1/chat/completions`, Alia's product API: the same handler `/alia/chat` mounts,
   * on the one surface that answers a browser from any Oxy app's origin (see `routes.ts`).
   */
  const {
    messages,
    append,
    isLoading,
    error,
    clearError,
    setMessages,
    stop,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    agentRun,
    failedTurn,
    retryFailedTurn: retry,
    clearFailedTurn,
    turnOptionsOf,
  } = useConversationStream({
    conversationId,
    model,
    agentId,
    clientContext,
    hostTools,
  });
  const upload = useDocumentUpload();

  // The turn's lifecycle, published for every "Ask Alia" button (`useAliaActivity`).
  const activitySource = useId();
  const activity = turnActivityState(messages, isLoading);
  useEffect(() => {
    const { setLocal } = useAliaActivityStore.getState();
    setLocal(activitySource, activity);
    return () => setLocal(activitySource, 'idle');
  }, [activitySource, activity]);

  // Expose streaming state globally so sidebar can show a spinner
  const setStreamingConversationId = useConversationStore((s) => s.setStreamingConversationId);
  useEffect(() => {
    setStreamingConversationId(isLoading && conversationId ? conversationId : null);
    return () => {
      if (useConversationStore.getState().streamingConversationId === conversationId) {
        setStreamingConversationId(null);
      }
    };
  }, [isLoading, conversationId, setStreamingConversationId]);

  // Refresh sidebar when streaming finishes (backend auto-saves with AI-generated title)
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && conversationId) {
      // Immediate refetch (gets saved conversation data)
      void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.all });
      void queryClient.invalidateQueries({
        queryKey: aliaQueryKeys.conversations.detail(conversationId),
      });
      // Delayed fallback for async title generation. Only the list needs it —
      // re-fetching the whole message detail 5s after every exchange just for
      // a possible title was a second full refetch per message.
      const timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.conversations.all });
      }, 5000);
      wasLoadingRef.current = isLoading;
      return () => clearTimeout(timer);
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, conversationId, queryClient]);

  // Sync chatId and load messages when conversation changes or when
  // seeded cache data upgrades to full data (messages go from empty to populated).
  useEffect(() => {
    if (!conversationId || conversationQueryLoading) return;

    const incomingMessages = conversation?.messages || [];
    const isNewConversation = lastConversationId.current !== conversationId;
    const isDataUpgrade =
      !isNewConversation && incomingMessages.length > 0 && messages.length === 0;

    if (!isNewConversation && !isDataUpgrade) return;

    if (isNewConversation) {
      lastConversationId.current = conversationId;
      hasSentPendingMessage.current = false;
    }

    const validMessages = incomingMessages
      .filter((msg) => msg?.role && msg?.content !== undefined)
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
    return host.subscribeConversationMessages?.(conversationId, (incoming) => {
      if (!incoming?.id) return;
      setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    });
  }, [conversationId, setMessages, host]);

  // Send pending initial message for new conversations
  useEffect(() => {
    if (!conversationId || !pendingInitialMessage || isLoading) return;
    // Addressed to the conversation it was made for: a second open thread must not take it.
    if (pendingInitialMessage.conversationId !== conversationId) return;
    if (hasSentPendingMessage.current) return;
    if (messages.length > 0) return; // Only send if no messages yet

    const pending = pendingInitialMessage;
    // Taken now: a failure is handed back to the account that sent it, never
    // to one signed in while the request was out.
    const newChatDraft = useComposerDraftStore.getState().address(null);
    hasSentPendingMessage.current = true;
    host.onTurnStart?.();
    useConversationStore.getState().clearPendingInitialMessage();

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
      host.closeConversation?.();
      toast.error(labels.sendFailed);
    });
  }, [
    conversationId,
    pendingInitialMessage,
    isLoading,
    messages.length,
    append,
    deleteConversation,
    host,
    labels,
  ]);

  // Actions
  const sendMessage = useCallback(
    async (
      content: string,
      attachments?: AliaAttachment[],
      options?: SendOptions,
    ): Promise<boolean> => {
      if ((!content.trim() && !attachments?.length) || isLoading) return false;
      const draft = useComposerDraftStore.getState().address(conversationId ?? null);

      host.onTurnStart?.();

      const built = attachments?.length
        ? await buildMessageContent(content, attachments, upload)
        : null;
      const messageContent = built ? built.content : content;
      reportDroppedAttachments(built?.dropped, labels);

      const outcome = await append({ role: 'user', content: messageContent }, options);

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
        toast.error(labels.sendFailed);
        return false;
      }
      // A retry re-sends the built content, whose bytes are inline.
      releaseAttachments(attachments ?? []);
      return true;
    },
    [isLoading, append, conversationId, host, labels, upload],
  );

  const startConversation = useStartConversation({ agentId });
  const createNewConversation = useCallback(
    (text: string, attachments?: AliaAttachment[], options?: SendOptions) =>
      startConversation(text, { attachments, options }),
    [startConversation],
  );

  /**
   * The conversation a voice call lives in: the open one, or — on a new-chat
   * screen — a new one, created now and shown, so the transcript has a home
   * the moment the call starts. `undefined` when it could not be created.
   */
  const ensureConversation = useCallback(async (): Promise<string | undefined> => {
    if (conversationId) return conversationId;
    try {
      const created = await createConversationMutation.mutateAsync({ agentId });
      host.openConversation?.(created.id);
      return created.id;
    } catch {
      // useCreateConversation.onError already told the person.
      return undefined;
    }
  }, [conversationId, createConversationMutation, agentId, host]);

  /** Leave this thread for an empty one. Nothing is deleted: the conversation stays in the list. */
  const startOver = useCallback(() => {
    stop();
    setMessages([]);
    clearFailedTurn();
    host.closeConversation?.();
  }, [stop, setMessages, clearFailedTurn, host]);

  /**
   * Rewrite a user turn: cut the thread back to it and send the new version.
   *
   * `attachments` are the ones added in the composer while editing. They go
   * AFTER whatever the turn already carried — a string edit keeps those, see
   * `EditedContent` — so rewording a question and adding a second picture is
   * one edit, not a lost picture.
   */
  const editMessage = useCallback(
    async (
      messageId: string,
      newContent: EditedContent,
      options?: SendOptions,
      attachments?: AliaAttachment[],
    ): Promise<boolean> => {
      // Truncate to messages before the edited one, then re-send.
      // setMessages eagerly syncs messagesRef so append reads truncated history.
      const beforeEdit = messages;
      const draft = useComposerDraftStore.getState().address(conversationId ?? null);
      const original = messages.find((msg) => msg.id === messageId);
      if (original === undefined) return false;
      // Like a send: while a reply streams, truncating the thread under it would let the old
      // stream keep writing into the new turn. The composer gets the words back.
      if (isLoading) return false;
      // A string edit keeps the original turn's attachments; only a full parts
      // array replaces them. See `EditedContent`.
      let content = mergeEditedContent(original.content, newContent);
      if (attachments?.length && typeof newContent === 'string') {
        const built = await buildMessageContent(newContent, attachments, upload);
        reportDroppedAttachments(built.dropped, labels);
        const added =
          typeof built.content === 'string'
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

      // An edit sends a new turn (so does a regenerate, through here).
      host.onTurnStart?.();

      setMessages((prev) => {
        const idx = prev.findIndex((msg) => msg.id === messageId);
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
        toast.error(labels.sendFailed);
        return false;
      }
      releaseAttachments(attachments ?? []);
      return true;
    },
    [setMessages, append, messages, conversationId, host, labels, upload, isLoading],
  );

  /** The user turn a reply answers: the nearest one before it, or `undefined`. */
  const promptOf = useCallback(
    (assistantMessageId: string): Message | undefined => {
      const idx = messages.findIndex((msg) => msg.id === assistantMessageId);
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i];
      }
      return undefined;
    },
    [messages],
  );

  /**
   * Ask for this reply again, with the options its prompt was sent with.
   *
   * `fallback` is for a prompt this screen did not send (the conversation was
   * reloaded since): nothing records what it carried, so the caller's current
   * choice — the composer's — is the best there is.
   */
  const regenerateMessage = useCallback(
    async (assistantMessageId: string, fallback?: SendOptions): Promise<boolean> => {
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
    },
    [promptOf, editMessage, turnOptionsOf],
  );

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
    host.onTurnStart?.();
    const outcome = await retry();
    return outcome !== 'failed';
  }, [isLoading, retry, host]);

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
        toast.error(labels.conversationClearFailed);
        return false;
      }
    }

    setMessages([]);
    // The message the error hung under is gone with the rest.
    clearFailedTurn();
    return true;
  }, [isLoading, stop, conversationId, clearMessages, setMessages, clearFailedTurn, labels]);

  // True while loading conversation messages (initial fetch or seeded→full upgrade)
  const conversationLoading =
    conversationQueryLoading ||
    (conversationFetching && (!conversation?.messages || conversation.messages.length === 0));

  return {
    // State
    conversationId,
    conversation,
    messages,
    isLoading,
    conversationLoading,
    error,

    // Actions
    sendMessage,
    createNewConversation,
    ensureConversation,
    startOver,
    editMessage,
    regenerateMessage,
    promptOf,
    turnOptionsOf,
    stopGeneration,
    clearConversation,
    clearError,
    setMessages,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    agentRun,
    failedTurn,
    retryFailedTurn,
  };
}

/** What `useConversationThread` hands back: the open conversation and everything that can be done to it. */
export type ConversationThread = ReturnType<typeof useConversationThread>;
