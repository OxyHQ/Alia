import { AgentResultCard } from '@/components/agent-result-card';
import { AgentTaskCard } from '@/components/agent-task-card';
import { WelcomeMessage } from '@/components/welcome-message';
import { FailedTurnCard } from '@/components/chat/failed-turn-card';
import { MessageBlockBoundary } from '@/components/chat/message-block-boundary';
import { ToolResultCard } from '@/components/chat/tool-result-card';
import { TurnStatusLine } from '@/components/chat/turn-status-line';
import type { FailedTurn } from '@/components/chat/turn-failure';
import { cardOf } from '@/lib/chat/tool-cards';
import { useOpenThought, type OpenThought } from '@/lib/chat/use-open-thought';
import { getToolPillLabel } from '@/lib/task-utils';
import { isWebInvocation, taskListLog, webSearchLog } from '@/lib/chat/work-log';
import { daySeparators } from '@/lib/message-days';
import { AgentProgress } from '@oxy.so/bloom/agent-progress';
import { ChatDateHeader } from '@oxy.so/bloom/chat-screen';
import { Divider } from '@oxy.so/bloom/divider';
import { TaskList } from '@oxy.so/bloom/task-list';
import { WebSearch } from '@oxy.so/bloom/web-search';
import { NewConversationOffer } from '@/components/new-conversation-offer';
import { CustomMarkdown } from '@/components/ui/markdown';
import { agentTint } from '@/lib/agents/agent-color';
import apiClient from '@/lib/api/client';
import { queryKeys } from '@/lib/hooks/query-keys';
import type { AgentActivityState } from '@/lib/hooks/use-agent-activity';
import type { Message } from '@/lib/hooks/use-conversations';
import { useTimelineShape, useTimelineWindow } from '@/lib/hooks/use-timeline-window';
import { useTranslation } from '@/lib/hooks/use-translation';
import { processMessage } from '@/lib/message-processor';
import { useStore, type ChatIdState } from '@/lib/stores/global-store';
import { useUIStore, type ThoughtScope } from '@/lib/stores/ui-store';
import { formatElapsed, turnTimings } from '@/lib/thought-utils';
import { threadSeamIds, type ThreadMessage } from '@/lib/thread-history';
import { arrivedIds } from '@/lib/chat/timeline';
import type { ToolInvocation } from '@/lib/types/messages';
import { useColorScheme } from '@/lib/useColorScheme';
import {
  getImagesFromContent,
  getTextFromContent,
  IdentityMark,
  PlanPreviewCard,
} from '@alia.onl/sdk';
import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import {
  AiChatAssistantMessage,
  AiChatThread,
  AiChatUserMessage,
  type AiChatThreadHandle,
  useAiChatChromeInsets,
} from '@oxy.so/bloom/ai-chat';
import { Loading } from '@oxy.so/bloom/loading';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Image } from '@/components/ui/image';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated from 'react-native-reanimated';

/** How near the end still counts as being at the bottom, px. */
export const AT_BOTTOM_THRESHOLD = 50;
/**
 * How near the top asks for the page above, px.
 *
 * A screenful of warning rather than the top itself: asking at zero leaves the
 * reader at a dead end while the request flies, and a thread is read upwards
 * at speed.
 */
const NEAR_TOP = 300;

/**
 * For a row the timings map has never heard of. It cannot happen — the map is
 * built from the very list being drawn — but `Map.get` says it might, and a
 * shared frozen object keeps the memoised rows from re-rendering on a fresh
 * `{}` if it ever does.
 */
const EMPTY_TIMING = Object.freeze({ startedAt: null, endedAt: null });

/**
 * The rows are the app's one `Message` (`lib/hooks/use-conversations.ts`), the
 * shape the streaming hook writes and the thought panel reads. A history row is
 * the same message plus where it sits in the thread (`ThreadMessage`). This
 * component used to declare a copy of its own — wider roles, optional content, a
 * `parts` array nothing ever sent — and cast back to the real one wherever the
 * two met.
 */
type ChatInterfaceProps = {
  messages: Message[];
  /**
   * Bloom's thread handle, for a jump to a cursor and for a restore.
   *
   * It replaced a `ScrollView` ref: the thread owns its scroll view now, and
   * `AiChatThreadHandle` is the seam — `scrollToEnd`, `scrollToOffset`, and
   * `getScrollView()` for the one thing neither covers (measuring a row for a
   * cursor jump).
   */
  threadRef: React.RefObject<AiChatThreadHandle | null>;
  /**
   * Ask for the page above. Absent where there is no history behind the
   * thread, which is also what turns the anchor off — Bloom only holds the
   * reader's position for growth it was asked for.
   */
  onLoadHistory?: () => void;
  isLoading?: boolean;
  conversationLoading?: boolean;
  onCopyMessage?: (content: string) => void;
  bottomPadding?: number;
  voiceAgentState?: 'idle' | 'listening' | 'thinking' | 'speaking';
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  agentActivity?: AgentActivityState | null;
  agentSessionId?: string | null;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  /** The agent's reason for offering a fresh stretch, or `null` for no offer. */
  suggestedNewConversation?: string | null;
  onAcceptNewConversation?: () => void;
  onDismissNewConversation?: () => void;
  /**
   * Everything said in this thread before the conversation on screen, oldest
   * first. Empty on `/c/:id`, which is one conversation with nothing behind it.
   */
  historyMessages?: ThreadMessage[];
  /** A page of history is on its way; the reader is at the top waiting for it. */
  isLoadingHistory?: boolean;
  /** The conversation being streamed into, which is what the thought panel reads. */
  activeConversationId?: string;
  /**
   * The message a jump was aimed at, by cursor, or `null` at the present.
   *
   * A window is half before the hit and half after, so landing at its end —
   * which is what the follow-the-newest half does with any list — leaves the
   * reader twenty messages past the thing they searched for.
   */
  focusCursor?: string | null;
  /**
   * The turn that got no answer, or `null`. Its card is drawn under the row
   * `anchorMessageId` names — the user message when nothing came back, the
   * partial answer when something did — so the error sits with the turn it
   * belongs to rather than at the end of the list.
   */
  failedTurn?: FailedTurn | null;
  onRetryTurn?: () => void;
};

/**
 * The history of a conversation that has none, as ONE array.
 *
 * A fresh `[]` per render would be a new dependency every time, which is what
 * turns a memo on the message list into a memo that never holds — and this list
 * re-renders per streamed token.
 */
const NO_HISTORY: ThreadMessage[] = [];

/** True for Alia's own assistant messages (excludes delegated agents). */
function isAliaOwnedMessage(m: Message): boolean {
  return m.role === 'assistant' && !m.agentInfo;
}

// Raw text extraction without the tag-stripping regex passes — cheap enough
// for per-flush presence/length checks during streaming.
function getRawMessageText(message: Message): string {
  return message.content ? getTextFromContent(message.content) : '';
}

// Helper function to extract and process text content for the app
function getMessageText(message: Message): string {
  // Process message for app platform (removes Telegram tags, keeps app components)
  const processed = processMessage(getRawMessageText(message), 'app');
  return processed.text;
}

// Extract image URLs from multi-part message content
function getMessageImages(message: Message): string[] {
  if (message.content) {
    return getImagesFromContent(message.content);
  }
  return [];
}

/** Whether a call returned a card, and so is left out of the work summary. */
function hasToolCard(t: ToolInvocation): boolean {
  return cardOf(t) !== null;
}

type MessageRowProps = {
  m: Message;
  index: number;
  isNewMessage: boolean;
  isLastAlia: boolean;
  isLoading?: boolean;
  chatId: ChatIdState;
  /** Where this row ended up, for the one row a jump is aimed at. */
  onRowLayout?: (e: LayoutChangeEvent) => void;
  handleCopyMessage: (content: string) => void;
  handleVote: (
    messageId: string,
    vote: 'up' | 'down',
    conversationId?: string,
  ) => void;
  /**
   * The turn's timing for its work summary, as primitives so the row's memo
   * holds: epoch ms of the send, and of the persisted end or `null` for a
   * turn the server has not stamped (`turnTiming` in `lib/thought-utils.ts`).
   */
  workStartedAt: number | null;
  workEndedAt: number | null;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  /** Open the thought panel on this turn, in the conversation it belongs to. */
  onOpenThought?: OpenThought;
};

const MessageRow = React.memo(function MessageRow({
  m,
  index,
  isNewMessage,
  isLastAlia,
  isLoading,
  chatId,
  onRowLayout,
  handleCopyMessage,
  handleVote,
  onApprovePlan,
  onRejectPlan,
  workStartedAt,
  workEndedAt,
  onOpenThought,
}: MessageRowProps) {
  const { colors } = useColorScheme();
  const { t: rowT } = useTranslation();
  const messageText = getMessageText(m);
  const messageImages = getMessageImages(m);

  /**
   * The calls the work summary lists: every one that did not draw its own
   * card. Read on each render — the list changes per streamed tool event and
   * the row is memoised on `m` already.
   */
  const workInvocations =
    m.role === 'assistant'
      ? (m.toolInvocations ?? []).filter((t) => !hasToolCard(t))
      : [];
  /** The template swaps the steps for the reply once the turn is done. */
  const turnWorking = isLoading && isLastAlia && m.isStreaming === true;
  /**
   * Where the turn went — searches, page visits, research — as a `WebSearch`
   * trail with its sources, and everything else it did as a `TaskList`. Both
   * are driven by `revealed` from the calls that have really arrived
   * (`lib/chat/work-log.ts`), never by their own demo ticker.
   */
  const webLog =
    m.role === 'assistant'
      ? webSearchLog(workInvocations, m.researchProgress, rowT)
      : null;
  const taskInvocations = workInvocations.filter((t) => !isWebInvocation(t));
  const taskLog =
    taskInvocations.length === 0 || turnWorking
      ? null
      : taskListLog(taskInvocations, false, rowT);
  const hasWorkLog =
    (webLog !== null && webLog.steps.length > 0) ||
    (workInvocations.length > 0 && !turnWorking);
  /** The calls that returned a card, drawn inside the turn where the answer is read. */
  const toolCards =
    m.role === 'assistant'
      ? (m.toolInvocations ?? []).flatMap((t, ti) => {
          const card = cardOf(t);
          return card === null ? [] : [{ key: t.toolCallId || `tool-${m.id}-${ti}`, card }];
        })
      : [];

  return (
    /**
     * The row no longer carries an entrance of its own.
     *
     * It used to run `FadeInUp.springify()` while the message inside it now
     * runs Bloom's reveal, which is two entrances for one arrival: the row
     * springs up and the reply then fades and un-blurs on top of it. Bloom's
     * is the one that belongs to the AI Chat composition — it staggers the
     * reply's blocks and it honours reduced motion — so it is the one that
     * stays, and the row is a plain layout element again.
     */
    <Animated.View key={m.id || `msg-${index}`} onLayout={onRowLayout}>
      {/* Plan Preview — shown before tool execution */}
      {m.pendingPlan &&
        (() => {
          const plan = m.pendingPlan;
          return (
            <MessageBlockBoundary>
              <PlanPreviewCard
                steps={plan.steps}
                approved={plan.approved}
                rejected={plan.rejected}
                onApprove={() => onApprovePlan?.(plan.planId)}
                onReject={() => onRejectPlan?.(plan.planId)}
              />
            </MessageBlockBoundary>
          );
        })()}

      {/* The template's steps: Bloom's AgentProgress, driven by the tool
          calls as the runtime reports them. Web calls are left to the
          WebSearch trail inside the turn, which streams them itself. */}
      {taskInvocations.length === 0 || !turnWorking ? null : (
        <AgentProgress
          steps={taskInvocations.map((t) => getToolPillLabel(t.toolName))}
          completedCount={
            taskInvocations.filter((t) => t.state === 'result').length
          }
        />
      )}

      {/* Message Content. `isStreaming` opens the block for VOICE only: a
          voice row shows its cursor before it has words, while a text turn's
          placeholder — stamped `isStreaming` too, now — is the thinking
          indicator's until its first token arrives. */}
      {(messageText.length > 0 ||
        messageImages.length > 0 ||
        (m.role === 'assistant' && (hasWorkLog || toolCards.length > 0)) ||
        (m.isStreaming && m.source === 'voice')) && (
        <View
          key="message-content"
          className="w-full"
        >
          {m.role === 'assistant' ? (
            <View className="flex-col">
              {m.agentInfo ? (
                <View className="flex-row items-center gap-2 mb-0.5">
                  <IdentityMark
                    size={20}
                    color={agentTint(m.agentInfo.color, colors)}
                    accessibilityLabel={m.agentInfo.name}
                  />
                  <Text className="text-xs font-semibold text-foreground">
                    {m.agentInfo.name}
                  </Text>
                </View>
              ) : null}
              {/* The template's reply: Bloom's reveal and its own feedback
                  row (like / dislike / copy). */}
              <AiChatAssistantMessage
                animate={isNewMessage}
                feedback={!m.isStreaming && messageText.length > 0}
                feedbackProps={{
                  onLike: () => handleVote(m.id, 'up', chatId?.id),
                  onDislike: () => handleVote(m.id, 'down', chatId?.id),
                  onCopy: () => handleCopyMessage(messageText),
                }}
              >
                {workInvocations.length === 0 || turnWorking ? null : (
                  <TurnStatusLine
                    label={
                      workStartedAt !== null && workEndedAt !== null
                        ? rowT('thought.workedFor', {
                            elapsed: formatElapsed(workEndedAt - workStartedAt),
                          })
                        : rowT('thought.worked')
                    }
                    hint={rowT('thought.viewDetails')}
                    onPress={onOpenThought && (() => onOpenThought(m.id, 'steps'))}
                  />
                )}
                {/* A turn that reasoned without tools: its reasoning, a press away. */}
                {workInvocations.length > 0 || !m.thinking || turnWorking ? null : (
                  <TurnStatusLine
                    label={rowT('thought.reasoning')}
                    hint={rowT('thought.viewDetails')}
                    onPress={onOpenThought && (() => onOpenThought(m.id, 'steps'))}
                  />
                )}
                {taskLog === null ? null : (
                  <TaskList
                    tasks={taskLog.tasks}
                    revealed={taskLog.revealed}
                    collapseOnComplete="all"
                    working={false}
                  />
                )}
                {webLog === null || webLog.steps.length === 0 ? null : (
                  <WebSearch
                    steps={webLog.steps}
                    revealed={webLog.revealed}
                    working={turnWorking ? rowT('chat.working') : false}
                    labels={{ sources: rowT('chat.sources') }}
                  />
                )}
                {/* Each card in its own boundary: `cardOf` checks the card's
                    NAME, and its data is cast unchecked. */}
                {toolCards.map(({ key, card }) => (
                  <MessageBlockBoundary key={key}>
                    <ToolResultCard card={card} />
                  </MessageBlockBoundary>
                ))}
                {/* The reply's text as Alia always drew it: its own Markdown
                    renderer (tables, headings, lists, code, citations), which
                    reads better than a line-per-block transcript. */}
                {m.source === 'voice' ? (
                  <Text className="text-base leading-7 text-foreground">
                    {messageText}
                    {m.isStreaming ? '\u258C' : ''}
                  </Text>
                ) : (
                  <CustomMarkdown
                    content={messageText}
                    toolInvocations={m.toolInvocations}
                    researchSources={m.researchProgress?.sources}
                  />
                )}
              </AiChatAssistantMessage>
            </View>
          ) : (
            // The template's user turn: Bloom's bubble, nothing under it, with
            // the breathing room above it the thread had before the refactor.
            <View className="mt-2 flex-col items-end">
              <AiChatUserMessage animate={isNewMessage}>
                {messageImages.length > 0 && (
                  <View className="flex-row flex-wrap gap-2">
                    {messageImages.map((imgUrl, imgIdx) => (
                      <View
                        key={`img-${imgIdx}`}
                        className="h-[120px] w-[120px] overflow-hidden rounded-xl"
                      >
                        <Image
                          source={{ uri: imgUrl }}
                          className="w-full h-full"
                          contentFit="cover"
                        />
                      </View>
                    ))}
                  </View>
                )}
                {messageText}
              </AiChatUserMessage>
            </View>
          )}
        </View>
      )}
    </Animated.View>
  );
});

export const ChatInterface = React.memo(function ChatInterface({
  messages,
  threadRef,
  onLoadHistory,
  isLoading,
  conversationLoading,
  onCopyMessage,
  bottomPadding = 0,
  voiceAgentState,
  onScroll,
  agentActivity,
  agentSessionId,
  onApprovePlan,
  onRejectPlan,
  suggestedNewConversation,
  onAcceptNewConversation,
  onDismissNewConversation,
  historyMessages,
  isLoadingHistory = false,
  activeConversationId,
  focusCursor,
  failedTurn,
  onRetryTurn,
}: ChatInterfaceProps) {
  const { t, locale } = useTranslation();
  /** This screen's votes, read to decide whether a press casts or retracts one. */
  const votesRef = useRef<Record<string, 'up' | 'down'>>({});
  const voteInFlightRef = useRef<Set<string>>(new Set());
  const syncThoughtScope = useUIStore((s) => s.syncThoughtScope);
  const queryClient = useQueryClient();
  const chatId = useStore((s) => s.chatId);

  const liveMessages = useMemo(
    () => messages.filter((m): m is Message => m != null && Boolean(m.role)),
    [messages],
  );
  const history = historyMessages ?? NO_HISTORY;
  /**
   * Everything on screen, in reading order: the thread's history first, the
   * conversation being streamed into after it.
   *
   * Every position below — which row is last, and which is the last of
   * Alia's — is an index into THIS, not into the live messages, which is why it
   * is built once here rather than concatenated at each use.
   */
  const filteredMessages = useMemo<Message[]>(
    () => (history.length === 0 ? liveMessages : [...history, ...liveMessages]),
    [history, liveMessages],
  );

  /**
   * The live list as its STRUCTURE — ids, roles, stamps, speakers — which a
   * streamed token never changes. Everything derived from the whole thread
   * (day lines, seams, turn timings, the last answer of Alia's, the window's
   * ids) is keyed on this rather than on the messages, so a token re-derives
   * nothing: it re-renders the row it was written into and that is all.
   */
  const liveShape = useTimelineShape(liveMessages);
  const shape = useMemo<readonly Message[]>(
    () => (history.length === 0 ? liveShape : [...history, ...liveShape]),
    [history, liveShape],
  );
  const rowIds = useMemo(() => shape.map((m) => m.id), [shape]);

  /**
   * The live rows that arrived since the last change to the list, which are
   * the only ones that animate in. A history row never does, and neither does a
   * conversation that was loaded or switched to (`arrivedIds`).
   */
  const previousLive = useRef<{ ids: readonly string[]; loading: boolean } | null>(null);
  const arrived = useMemo(
    () =>
      arrivedIds(
        previousLive.current?.ids ?? null,
        previousLive.current?.loading ?? false,
        liveShape,
      ),
    [liveShape],
  );
  useEffect(() => {
    previousLive.current = {
      ids: liveShape.map((m) => m.id),
      loading: conversationLoading === true,
    };
  }, [liveShape, conversationLoading]);

  /**
   * Every turn's start and end, computed once for the whole thread.
   *
   * `renderMessage` used to ask `turnTiming(m, filteredMessages)` per row,
   * handing it the entire list each time — and that function has to FIND the
   * row before it can answer, so each call opened with a `findIndex` across
   * the thread and then walked backwards for the send. Two scans per row
   * makes drawing n messages O(n²), and this list re-renders roughly twenty
   * times a second while an answer streams. Measured: 8.3ms per render at
   * 1,000 messages and 80ms at 5,000, recomputing on every token an answer
   * that only changes when the thread does.
   *
   * One pass over the same list gives the same answers — pinned row by row
   * against the old function in `lib/__tests__/turn-timings-scale.test.ts` —
   * and the memo means a streamed token does not trigger even that.
   */
  const timingsByMessage = useMemo(() => turnTimings(shape), [shape]);

  /**
   * The conversation each history message belongs to, as the id a row's own
   * actions address.
   *
   * A vote goes to `/conversations/:id/messages/:id/vote`, and it used to
   * take the id of the stretch on screen — right for a live message and wrong for every history one, which
   * belongs to a conversation that ended. It would have written to a
   * conversation that does not contain the message, and failed quietly.
   *
   * One entry per conversation rather than per message: these are props of a
   * memoized row, so a fresh object per row would re-render every one of them
   * on every streamed token.
   */
  const historyChatIds = useMemo(() => {
    const byConversation = new Map<string, ChatIdState>();
    for (const message of history) {
      if (byConversation.has(message.conversationId)) continue;
      byConversation.set(message.conversationId, {
        id: message.conversationId,
        from: 'url',
      });
    }
    return byConversation;
  }, [history]);

  /**
   * The day each message starts, when it starts a new one: Bloom's inline
   * `ChatDateHeader` above it, with the label pre-formatted here as the
   * component asks — the app owns the locale and the timezone.
   */
  const dayLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const separator of daySeparators(shape, new Date(), locale)) {
      const { label } = separator;
      labels.set(
        separator.messageId,
        label.kind === 'today'
          ? t('chat.today')
          : label.kind === 'yesterday'
            ? t('chat.yesterday')
            : label.text,
      );
    }
    return labels;
  }, [shape, locale, t]);

  /**
   * Where one conversation of a thread ends and the next begins: the model was
   * given a fresh context there, and everything above is out of its sight. A
   * rule with a label rather than the day's pill, because it is a fact about
   * the thread and not about the calendar (`threadSeamIds`).
   */
  const seamIds = useMemo(
    () => threadSeamIds(history, liveShape, activeConversationId ?? ''),
    [history, liveShape, activeConversationId],
  );

  const lastAliaIndex = useMemo(
    () => shape.reduce((acc, m, i) => (isAliaOwnedMessage(m) ? i : acc), -1),
    [shape],
  );

  /**
   * This conversation as the thought panel reads it: its messages, whether
   * they are all here yet, and the turn in flight.
   *
   * Keyed on the conversation and its messages, NOT on the panel being open.
   * Syncing only while the panel was open meant the first press on a tool
   * row rendered against whatever the store held before — another
   * conversation's messages, or none — and found nothing by id (#542).
   * The store accepts this only while the open selection belongs to the
   * same conversation, so the new-chat screen mounted underneath cannot
   * blank a panel opened here.
   *
   * A load that failed is read off the query cache at the moment the memo
   * recomputes: the load's end is what flips `conversationLoading`, so the
   * read is fresh exactly when it matters.
   */
  const liveThoughtScope = useMemo<ThoughtScope>(() => {
    const loadFailed =
      activeConversationId !== undefined &&
      queryClient.getQueryState(
        queryKeys.conversations.detail(activeConversationId),
      )?.status === 'error';
    return {
      conversationId: activeConversationId ?? null,
      messages: liveMessages,
      status: conversationLoading ? 'loading' : loadFailed ? 'failed' : 'ready',
      isLoading: isLoading === true,
      failedTurn: failedTurn ?? null,
    };
  }, [
    activeConversationId,
    liveMessages,
    conversationLoading,
    isLoading,
    failedTurn,
    queryClient,
  ]);

  useEffect(() => {
    syncThoughtScope(liveThoughtScope);
  }, [liveThoughtScope, syncThoughtScope]);
  const openThought = useOpenThought(liveThoughtScope, history);

  /**
   * The agent's first tool of a turn — a search, a page it reads, a command —
   * opens the thought panel on that turn, unless a panel is already open. Once
   * per turn: a reader who closes it keeps it closed.
   */
  const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
  const autoOpenedTurn = useRef<string | null>(null);
  const workingTurn = isLoading ? liveMessages[liveMessages.length - 1] : undefined;
  const workingTurnId =
    workingTurn?.role === 'assistant' && (workingTurn.toolInvocations?.length ?? 0) > 0
      ? workingTurn.id
      : null;
  useEffect(() => {
    if (workingTurnId === null || autoOpenedTurn.current === workingTurnId) return;
    autoOpenedTurn.current = workingTurnId;
    if (useUIStore.getState().rightPanel === null) openThoughtPanel(workingTurnId, liveThoughtScope);
  }, [workingTurnId, liveThoughtScope, openThoughtPanel]);

  const handleCopyMessage = useCallback(
    async (content: string) => {
      await Clipboard.setStringAsync(content);
      toast.success(t('chat.copiedToClipboard'));
      onCopyMessage?.(content);
    },
    [onCopyMessage, t],
  );

  /**
   * `conversationId` comes from the ROW, not from the screen.
   *
   * The vote is addressed to the conversation the message is in, and a thread
   * shows several: taking the id of the stretch on screen would send an old
   * message's vote to a conversation that does not contain it, where it can
   * only fail — and it fails silently, because the only report is a toast on
   * success.
   */
  const handleVote = useCallback(
    (messageId: string, vote: 'up' | 'down', conversationId?: string) => {
      if (voteInFlightRef.current.has(messageId)) return;
      const newVote = votesRef.current[messageId] === vote ? null : vote;
      if (newVote) votesRef.current[messageId] = newVote;
      else delete votesRef.current[messageId];
      if (conversationId === undefined) return;
      voteInFlightRef.current.add(messageId);
      apiClient
        .patch(`/conversations/${conversationId}/messages/${messageId}/vote`, {
          vote: newVote,
        })
        .then(() => toast.success(t('chat.thanksFeedback')))
        .catch(() => {
          delete votesRef.current[messageId];
        })
        .finally(() => voteInFlightRef.current.delete(messageId));
    },
    [t],
  );

  /** Optional extra thread clearance; the template composer occupies its own row. */
  const bottomSpacerStyle = useMemo(
    () => ({ height: bottomPadding }),
    [bottomPadding],
  );

  /**
   * Put the message a jump was aimed at under the reader's eyes.
   *
   * Re-applied on every layout of that row rather than once, for the same
   * reason the history anchor is: the rows above it settle in installments,
   * so the first position it reports is not the one it keeps. Each call
   * supersedes the last and the final one is right.
   *
   * The `y` is measured inside the list, which begins exactly at the
   * thread's top padding — so scrolling to it lands the message a padding's
   * width below the top edge rather than flush against it, which is where a
   * message you went looking for wants to be.
   */
  const handleFocusLayout = useCallback(
    (e: LayoutChangeEvent) => {
      threadRef.current?.scrollToOffset({
        offset: Math.max(0, e.nativeEvent.layout.y),
      });
    },
    [threadRef],
  );

  /** The row a cursor jump was aimed at, as an index into what is shown, or -1. */
  const focusIndex = useMemo(
    () =>
      focusCursor === undefined || focusCursor === null
        ? -1
        : history.findIndex((m) => m.cursor === focusCursor),
    [history, focusCursor],
  );

  /**
   * Which rows are mounted, and the scroll that goes with them: the newest
   * page first, older ones revealed as the reader nears the top, and the
   * position a conversation is returned to (`useTimelineWindow`). A jump's
   * window of the past is not remembered — its key is `null`.
   */
  const timeline = useTimelineWindow({
    ids: rowIds,
    scrollKey: focusCursor == null ? (activeConversationId ?? null) : null,
    ready: conversationLoading !== true,
    focusIndex,
    turnInFlight: isLoading === true,
    atBottomThreshold: AT_BOTTOM_THRESHOLD,
    threadRef,
    onLoadHistory,
    onScroll,
  });

  /**
   * One message, wherever it sits in the whole of what is shown.
   *
   * `index` is a position in `filteredMessages` — history and live together —
   * because that is what "is this the last one" is measured in.
   */
  const renderMessage = (m: Message, index: number) => {
    const fromHistory = index < history.length;
    // The send before this answer and the answer's own stamp bracket its
    // work; both are primitives so the memoised row below holds. Looked up
    // rather than computed: see `timingsByMessage`.
    const timing = timingsByMessage.get(m.id) ?? EMPTY_TIMING;
    const dayLabel = dayLabels.get(m.id);
    const isLastAlia = index === lastAliaIndex;

    return (
      <React.Fragment key={m.id || `msg-${index}`}>
        {seamIds.has(m.id) ? (
          <Divider spacing={16}>{t('chat.newStretch')}</Divider>
        ) : null}
        {dayLabel === undefined ? null : (
          <ChatDateHeader label={dayLabel} placement="inline" />
        )}
        <MessageRow
          m={m}
          index={index}
          // Only a message that arrived while this conversation was open
          // animates in; none of the history ever does (`arrivedIds`).
          isNewMessage={!fromHistory && arrived.has(m.id)}
          isLastAlia={isLastAlia}
          // Only the last answer reads it, and handing it to every row would
          // re-render the whole thread when a turn starts and when it ends.
          isLoading={isLastAlia ? isLoading : false}
          chatId={
            fromHistory
              ? (historyChatIds.get(history[index].conversationId) ?? chatId)
              : chatId
          }
          onRowLayout={index === focusIndex ? handleFocusLayout : undefined}
          handleCopyMessage={handleCopyMessage}
          handleVote={handleVote}
          workStartedAt={timing.startedAt}
          workEndedAt={timing.endedAt}
          onOpenThought={openThought}
          onApprovePlan={onApprovePlan}
          onRejectPlan={onRejectPlan}
        />
        {failedTurn === null ||
        failedTurn === undefined ||
        failedTurn.anchorMessageId !== m.id ? null : (
          <FailedTurnCard
            partial={failedTurn.partial}
            retryable={failedTurn.retryable}
            detail={failedTurn.detail}
            onRetry={onRetryTurn}
          />
        )}
      </React.Fragment>
    );
  };

  /*
   * Bloom's thread, with the four behaviours Alia's own scroll hook had.
   *
   * `followAnimated={false}` is the one that is not a default, and it is the
   * rule `use-scroll-to-bottom.ts` was built around: an ANIMATED
   * `scrollToEnd` emits a run of intermediate positions from above the end,
   * and anything reading those as the reader's own scrolling stops following
   * at the first token — the classic autoscroll that switches itself off and
   * looks random. Unanimated there are no intermediate positions, so the
   * trap is unreachable rather than guarded against.
   *
   * `onStartReached` rather than an end-reached: a chat pages UPWARD.
   * `maintainStartPosition` adds the page's growth to the offset so the turn
   * being read does not slide away under it — without that, a reader near
   * the top is left near the top, asking for the next page, and the next,
   * until the whole thread has been pulled in.
   *
   * The keyboard is handled by `ChatWorkspace` one level up: Bloom's AI Chat
   * family imports no keyboard controller at all.
   */
  const chromeInsets = useAiChatChromeInsets();
  /**
   * Nothing said yet and nothing on its way: Alia's greeting, centred in the
   * space the composer leaves, as it has always been.
   */
  const isEmpty =
    filteredMessages.length === 0 &&
    !conversationLoading &&
    !isLoading &&
    !isLoadingHistory &&
    voiceAgentState !== 'thinking';
  if (isEmpty) {
    return (
      // Above the floating composer: the container measures it for us.
      <View className="flex-1 justify-center px-4" style={{ paddingBottom: chromeInsets?.bottom ?? 0 }}>
        <View className="w-full max-w-[768px] self-center">
          <WelcomeMessage />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <AiChatThread
        ref={threadRef}
        followAnimated={false}
        followThreshold={AT_BOTTOM_THRESHOLD}
        onStartReached={timeline.onStartReached}
        onStartReachedThreshold={NEAR_TOP}
        maintainStartPosition={timeline.onStartReached !== undefined}
        onScroll={timeline.onScroll}
      >
        {/* The transcript column, centred: a little wider than the composer
            (896 against its 768), so the answer has room to breathe. */}
        <View className="w-full max-w-4xl self-center">
          {!filteredMessages.length && conversationLoading ? (
              <View className="gap-5 py-4">
                <View className="items-end">
                  <Skeleton.Box width="65%" height={48} borderRadius={24} />
                </View>
                <View className="items-start gap-2.5">
                  <Skeleton.Box width="80%" height={14} borderRadius={8} />
                  <Skeleton.Box width="70%" height={14} borderRadius={8} />
                  <Skeleton.Box width="45%" height={14} borderRadius={8} />
                </View>
                <View className="items-end">
                  <Skeleton.Box width="50%" height={40} borderRadius={24} />
                </View>
                <View className="items-start gap-2.5">
                  <Skeleton.Box width="85%" height={14} borderRadius={8} />
                  <Skeleton.Box width="60%" height={14} borderRadius={8} />
                </View>
              </View>
          ) : null}

          <View className="relative" onLayout={timeline.onListLayout}>
            {/* The slot the history loader shows in, held open for as long as
                there is history to load. The thread anchors ONE growth per
                request — the first after `onStartReached` — so a loader that
                appeared on request would spend that anchor on itself and leave
                the page that follows it to push the reader down. */}
            {onLoadHistory === undefined && !isLoadingHistory ? null : (
              <View className="h-14 items-center justify-center">
                {!isLoadingHistory ? null : (
                  <Loading variant="inline" text={t('chat.loadingHistory')} />
                )}
              </View>
            )}
            {filteredMessages
              .slice(timeline.start)
              .map((m, offset) => renderMessage(m, timeline.start + offset))}
          </View>

          {/* Agent execution — in-progress card or completed result card */}
          {agentActivity &&
            agentActivity.eventCount > 0 &&
            (agentActivity.isComplete && agentSessionId ? (
              <AgentResultCard activity={agentActivity} />
            ) : (
              <AgentTaskCard activity={agentActivity} />
            ))}

          {/* The agent's offer to start the next stretch fresh. Last in the
                list on purpose: it must not cover what is being read, and
                ignoring it has to leave the thread exactly as it was. */}
          {suggestedNewConversation === null ||
          suggestedNewConversation === undefined ? null : (
            <NewConversationOffer
              reason={suggestedNewConversation}
              onAccept={onAcceptNewConversation ?? (() => {})}
              onDismiss={onDismissNewConversation ?? (() => {})}
            />
          )}

          {/* Standalone waiting indicator for voice mode — shows when AI is thinking
                but there's no pending assistant message yet (e.g. right after user speaks) */}
          {voiceAgentState === 'thinking' &&
            !isLoading &&
            (messages.length === 0 ||
              messages[messages.length - 1]?.role !== 'assistant') && (
              <AgentThinking
                variant="wave"
                label={t('chat.thinking')}
                showTimer={false}
              />
            )}

          {/* Bloom's `AgentChat`: while a turn is busy and its reply has no
              word yet, AgentThinking sits under the transcript, in its column.
              A turn already running tools shows their own working line. */}
          {isLoading &&
            (() => {
              const last = messages[messages.length - 1];
              if (last === undefined || last.role === 'user') return true;
              return (
                last.role === 'assistant' &&
                getMessageText(last).length === 0 &&
                (last.toolInvocations?.length ?? 0) === 0
              );
            })() && <AgentThinking variant="wave" label={t('chat.thinking')} />}
        </View>
        <View style={bottomSpacerStyle} />
      </AiChatThread>
    </View>
  );
});
