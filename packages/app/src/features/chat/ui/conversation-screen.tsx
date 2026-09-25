import { ChatHeaderActions } from '@/features/chat/ui/chat-header-actions';
import { ChatPageContent } from '@/features/chat/ui/chat-page-content';
import { ThreadSearch } from '@/features/chat/ui/thread-search';
import { UsageLimitDialog } from '@/features/billing/ui/usage-limit-dialog';
import { deliverMarkdownFile } from '@/features/chat/runtime/conversation-share';
import {
  buildConversationMarkdown,
  exportFilename,
} from '@/features/chat/model/conversation-export';
import { UsageLimitError } from '@/features/billing/model/usage-limit-error';
import { queryKeys } from '@/shared/api/query-keys';
import { resolveSelection, useCatalogue } from '@/features/chat/runtime/use-catalogue';
import { useChatConversation } from '@/features/chat/runtime/use-chat-conversation';
import { useAgentActivity } from '@/features/chat/runtime/use-agent-activity';
import {
  useConversation,
  useCreateConversation,
  useDeleteConversation,
} from '@/features/chat/runtime/use-conversations';
import { useProductModes } from '@/features/chat/runtime/use-product-modes';
import { useVoiceSoundEffects } from '@/shared/platform/use-sound-effects';
import type { Attachment, SendOptions } from '@/shared/contracts/chat-turn';
import { useThreadHistory } from '@/features/chat/runtime/use-thread-history';
import {
  useThreadWindow,
  type ThreadSearchHit,
} from '@/features/chat/runtime/use-thread-search';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useVoiceMode } from '@/features/voice/runtime/use-voice-mode';
import { useModelStore } from '@/features/chat/runtime/model-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import type { Message } from '@/features/chat/model/chat';
import { Button } from '@oxy.so/bloom/button';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import { usePathname, useRouter } from 'expo-router';
import { useScreenOnShow } from '@/shared/platform/use-screen-on-show';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

interface ConversationScreenProps {
  conversationId: string;
  /** The agent answering, when this thread belongs to one. */
  agentId?: string;
  /** The agent's name, for the title when the chat has none. */
  agentName?: string;
  /**
   * The handle whose thread this is, when it is one.
   *
   * Only used to re-read the thread after a new stretch is started: the route
   * shows the ACTIVE stretch, and starting one makes a different conversation
   * active. Absent on `/c/:id`, which is a single conversation with no thread
   * behind it and therefore nothing to re-read.
   */
  threadHandle?: string;
  /** Open straight into voice, once. */
  startVoice?: boolean;
}

/**
 * No live conversation, as ONE array — a new `[]` per render would be a fresh
 * dependency on every one of them, and this screen renders per streamed token.
 */
const NO_MESSAGES: Message[] = [];

/**
 * One open conversation — the whole of it, wherever it was reached from.
 *
 * There are two doors: `/c/:id`, a chat in the sidebar, and `/a/:username`, the
 * permanent thread with one agent. They are the SAME screen behind different
 * doors, so it lives here rather than in either route: a chat that gains voice
 * or loses a dialog has to gain or lose it in both, and two copies of this
 * wiring would drift the first time only one of them was edited.
 */
export const ConversationScreen = ({
  conversationId,
  agentId,
  agentName,
  threadHandle,
  startVoice = false,
}: ConversationScreenProps) => {
  // A conversation keeps its own choice once one is made here, and follows the
  // user's standing choice until then. It used to open on a hard-coded
  // identifier instead, which silently discarded the model the user had picked
  // on the screen that started the conversation.
  const { data: conversationDetails } = useConversation(conversationId);
  const globalModel = useModelStore((s) => s.selectedModel);
  const [conversationModel, setConversationModel] = useState<string | null>(
    null,
  );
  const selectedModel = conversationModel ?? globalModel;
  const { data: catalogue } = useCatalogue();
  const { data: modes } = useProductModes();
  const selection = resolveSelection(
    selectedModel,
    catalogue,
    undefined,
    modes,
  );
  /**
   * A request flag, read from the store rather than inferred from the model.
   *
   * It used to be `selection.effectiveId === THINKING_MODEL_ID`, which made
   * extended reasoning a property of WHICH model was chosen. The routing table
   * shows that was never true: `route:thinking` and `route:pro` are two
   * aliases of one profile, so the "thinking model" and the "maximum quality
   * model" routed identically and differed only by the prompt this flag selects.
   */
  const reasoningEffort = useModelStore((s) => s.reasoningEffort);

  const {
    messages,
    isLoading,
    conversationLoading,
    error,
    sendMessage,
    stopGeneration,
    clearConversation,
    clearError,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    failedTurn,
    retryFailedTurn,
    editMessage,
    regenerateMessage,
    turnOptionsOf,
  } = useChatConversation({
    conversationId,
    reasoningEffort,
    selectedModel: selection.effectiveId ?? undefined,
    agentId,
  });

  /**
   * Everything said before this conversation, when this screen is a thread.
   *
   * `/c/:id` passes no handle and gets nothing: a chat in the sidebar is one
   * conversation, and there is nothing behind it to page into.
   */
  const history = useThreadHistory(threadHandle, conversationId);

  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * The message the reader jumped to, or `null` for the present.
   *
   * A thread has two states and they are not variations of one: at the present,
   * the history runs into the conversation being streamed into; at a moment,
   * the screen shows the stretch around one old message and there is nothing
   * live beneath it. The way back is leaving, not scrolling — the endpoint
   * pages BACKWARDS only, so walking forward from a jump would be a road that
   * ends.
   */
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);
  const past = useThreadWindow(threadHandle, jumpedTo);
  const jumped = jumpedTo !== null;

  /**
   * Open the thread around a hit, and close the search over it.
   *
   * The cursor rather than the message id: an id addresses a message, and only
   * a cursor addresses a POSITION, which is what a window is asked for.
   */
  const handleJump = useCallback((hit: ThreadSearchHit) => {
    setJumpedTo(hit.cursor);
    setSearchOpen(false);
  }, []);

  const handleBackToLatest = useCallback(() => setJumpedTo(null), []);
  const handleSearchOpen = useCallback(() => setSearchOpen(true), []);
  const handleSearchClose = useCallback(() => setSearchOpen(false), []);

  const createConversation = useCreateConversation();
  const queryClient = useQueryClient();

  /**
   * Take the agent up on its offer: start the next stretch of this thread.
   *
   * The agent cannot do this — its tool emits one frame and writes nothing — so
   * the act is the person's, here. A new conversation with the same agent
   * becomes the most recent, which is the one `GET /agents/thread/:username`
   * calls active, so re-reading the thread is what moves the screen onto it.
   *
   * Dismissed either way: whether the creation succeeds or fails, the offer has
   * been answered, and a failure is already reported by the mutation.
   */
  const handleAcceptNewConversation = useCallback(() => {
    dismissSuggestedNewConversation();
    if (agentId === undefined) return;
    createConversation.mutate(
      { agentId },
      {
        onSuccess: () => {
          if (threadHandle === undefined) return;
          queryClient.invalidateQueries({
            queryKey: queryKeys.agents.thread(threadHandle),
          });
          /**
           * And the history with it. The stretch that was live becomes history
           * the moment a new one is active, and the pages held were fetched
           * before its last turns existed — kept, they would put the reader back
           * at a version of the conversation they just finished having.
           */
          queryClient.invalidateQueries({
            queryKey: queryKeys.agents.threadMessages(threadHandle),
          });
        },
      },
    );
  }, [
    agentId,
    threadHandle,
    createConversation,
    queryClient,
    dismissSuggestedNewConversation,
  ]);

  /**
   * The messages, for the export — behind a ref so `handleExport` is built
   * once: the header's menu is memoised against this screen, which re-renders
   * per streamed token, and still sees the thread as it is when chosen.
   */
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /**
   * Export the conversation as a Markdown document. The title is read out of
   * the query cache at the moment of the export: the `alia.title` frame writes
   * the generated title into the same key, so this sees it without a
   * subscription of its own.
   */
  const handleExport = useCallback(() => {
    const cached = queryClient.getQueryData<{ title?: string }>(
      queryKeys.conversations.detail(conversationId),
    );
    const title = cached?.title?.trim() || agentName || t('chat.newChat');
    const exportedAt = new Date();
    const markdown = buildConversationMarkdown({
      title,
      messages: messagesRef.current,
      exportedAt,
      assistantName: agentName,
      userLabel: t('chat.searchThreadYou'),
    });
    deliverMarkdownFile(exportFilename(title, exportedAt), markdown, title).catch(
      () => {
        toast.error(t('chat.exportFailed'));
      },
    );
  }, [queryClient, conversationId, agentName, t]);

  /**
   * Delete this conversation, once the person has confirmed it, and go home.
   *
   * Only on `/c/:id`: an agent's thread is a view over several conversations,
   * and deleting the one on screen would quietly put the previous stretch in
   * its place rather than remove "the chat". A refusal is already reported by
   * the mutation's own toast.
   */
  const deleteConversation = useDeleteConversation();
  const router = useRouter();
  const handleDelete = useCallback(async () => {
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
   * The agent run this conversation started, if it started one: the session
   * the `alia.agent_turn` frame opened, only while that frame came from THIS
   * conversation — the store holds one session for the whole app, and a
   * second mounted chat must not draw another chat's run.
   */
  const activeAgentSessionId = useUIStore((s) =>
    s.activeAgentConversationId === conversationId ? s.activeAgentSessionId : null,
  );
  const activeAgentId = useUIStore((s) => s.activeAgentId);
  const agentActivity = useAgentActivity(activeAgentSessionId, activeAgentId);

  /**
   * The agent whose terminal this chat can show: the thread's own agent, or
   * the one a turn of THIS conversation put to work. The panel keeps it for
   * the route it was opened on, so another chat never shows it.
   */
  const agentTurnHere = useUIStore((s) => s.activeAgentConversationId === conversationId);
  const terminalAgentId = agentId ?? (agentTurnHere && activeAgentId ? activeAgentId : undefined);
  const pathname = usePathname();
  const handleOpenTerminal = useCallback(() => {
    if (terminalAgentId !== undefined) useUIStore.getState().openAgentTerminal(terminalAgentId, pathname);
  }, [terminalAgentId, pathname]);

  const headerActions = (
    <ChatHeaderActions
      onSearch={threadHandle === undefined ? undefined : handleSearchOpen}
      onExport={handleExport}
      onClear={clearConversation}
      onOpenTerminal={terminalAgentId === undefined ? undefined : handleOpenTerminal}
      onDelete={threadHandle === undefined ? handleDelete : undefined}
    />
  );

  /**
   * Writing is done in the present, so it ends a jump.
   *
   * The turn goes to the live conversation either way — that is where the
   * screen is streaming — and leaving the reader looking at a stretch from
   * March while their message lands somewhere off-screen is the one outcome
   * that would be a lie.
   */
  const handleSubmit = useCallback(
    (value: string, attachments?: Attachment[], options?: SendOptions) => {
      setJumpedTo(null);
      return sendMessage(value, attachments, options);
    },
    [sendMessage],
  );

  /**
   * A call speaks through this conversation's own send, so its turns are
   * ordinary turns of it — persisted by the server as they happen, which is
   * why nothing is saved when the call ends.
   */
  // And it is this conversation's, this account's and this screen's: it ends
  // when any of the three stops being true (see `use-voice-mode.ts`).
  const { user } = useOxy();
  const isFocused = useScreenOnShow();
  const voice = useVoiceMode({
    sendMessage: handleSubmit,
    stopGeneration,
    owner: `${user?.id ?? 'guest'}:${conversationId}`,
    isFocused,
  });

  // Auto-activate voice when navigated with startVoice (once only)
  const voiceAutoStartedRef = useRef(false);
  useEffect(() => {
    if (
      startVoice &&
      !voiceAutoStartedRef.current &&
      voice.roomState === 'disconnected'
    ) {
      voiceAutoStartedRef.current = true;
      voice.activateVoice();
    }
  }, [startVoice, voice.roomState]);

  // Sound effects for voice mode (thinking, tool calls, connect/disconnect)
  useVoiceSoundEffects({
    isVoiceActive: voice.isVoiceActive,
    agentState: voice.agentState,
    isConnected: voice.isConnected,
  });

  // Check both instanceof AND name — Hermes can break instanceof for Error subclasses
  const usageLimitError =
    error instanceof UsageLimitError || error?.name === 'UsageLimitError'
      ? (error as UsageLimitError)
      : null;

  return (
    <>
        <ChatPageContent
          selectedModel={selectedModel}
          onModelChange={setConversationModel}
          conversationTitle={conversationDetails?.title}
          // Nothing live under a window: it is a view of the past, and the
          // conversation being streamed into is not below it in the thread.
          messages={jumped ? NO_MESSAGES : messages}
          conversationId={conversationId}
          isLoading={isLoading}
          conversationLoading={conversationLoading}
          onSubmit={handleSubmit}
          onStop={stopGeneration}
          onEditMessage={editMessage}
          onRegenerateMessage={regenerateMessage}
          turnOptionsOf={turnOptionsOf}
          disabled={!!usageLimitError}
          voice={voice}
          agentName={agentName}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
          suggestedNewConversation={suggestedNewConversation}
          onAcceptNewConversation={handleAcceptNewConversation}
          onDismissNewConversation={dismissSuggestedNewConversation}
          historyMessages={jumped ? past.messages : history.messages}
          hasMoreHistory={jumped ? past.hasMore : history.hasMore}
          isLoadingHistory={
            jumped
              ? past.isLoadingMore || past.isLoading
              : history.isLoadingMore
          }
          onLoadHistory={jumped ? past.loadMore : history.loadMore}
          focusCursor={jumpedTo}
          failedTurn={failedTurn}
          onRetryTurn={retryFailedTurn}
          headerActions={headerActions}
          agentActivity={activeAgentSessionId === null ? null : agentActivity}
          agentSessionId={activeAgentSessionId}
        />
        {!jumped ? null : (
          <View
            className="absolute inset-x-0 top-16 z-10 items-center"
            pointerEvents="box-none"
          >
            <Button
              variant="secondary"
              size="sm"
              onPress={handleBackToLatest}
            >
              {t('chat.backToLatest')}
            </Button>
          </View>
        )}
        {!searchOpen || threadHandle === undefined ? null : (
          <ThreadSearch
            handle={threadHandle}
            onJump={handleJump}
            onClose={handleSearchClose}
          />
        )}
        <UsageLimitDialog error={usageLimitError} onDismiss={clearError} />
    </>
  );
};
