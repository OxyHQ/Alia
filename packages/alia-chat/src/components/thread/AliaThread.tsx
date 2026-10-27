import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import { AiChatThread, type AiChatThreadHandle } from '@oxy.so/bloom/ai-chat';
import { ChatDateHeader } from '@oxy.so/bloom/chat-screen';
import { Divider } from '@oxy.so/bloom/divider';
import { Loading } from '@oxy.so/bloom/loading';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Fragment, memo, type ReactNode, type RefObject, useCallback, useMemo } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
} from 'react-native';
import { AT_BOTTOM_THRESHOLD } from '../../hooks/useAtBottom';
import { useMessageVote } from '../../hooks/useMessageVote';
import { useOpenThought } from '../../hooks/useOpenThought';
import { useReadAloud } from '../../hooks/useReadAloud';
import { useThoughtScope } from '../../hooks/useThoughtScope';
import { useThreadRows } from '../../hooks/useThreadRows';
import { useTimelineWindow } from '../../hooks/useTimelineWindow';
import { useFailedTurnToast } from '../../hooks/useFailedTurnToast';
import { copyText } from '../../lib/clipboard';
import { messageText } from '../../lib/content-utils';
import { useLabels } from '../../lib/labels';
import type { AgentActivityState } from '../../runtime/thread/agent-activity';
import type { FailedTurn } from '../../runtime/turn-failure';
import type { Message } from '../../runtime/types';
import type { ThreadHistory } from '../../runtime/thread/thread-history';
import type { AgentState } from '../../types';
import { AgentResultCard } from './AgentResultCard';
import { AgentTaskCard } from './AgentTaskCard';
import { NewConversationOffer } from './NewConversationOffer';
import { type ThreadActions, ThreadRow } from './ThreadRow';

/**
 * How near the top asks for the page above, px.
 *
 * A screenful of warning rather than the top itself: asking at zero leaves the reader at a dead
 * end while the request flies, and a thread is read upwards at speed.
 */
const NEAR_TOP = 300;

/** The agent's offer to start the next stretch of the thread fresh. */
export interface NewConversationOfferProps {
  /** The agent's reason for offering. */
  reason: string;
  onAccept: () => void;
  onDismiss: () => void;
}

export interface AliaThreadProps {
  /** The conversation being streamed into. */
  messages: Message[];
  /** The conversation on screen: what a vote, a saved scroll position and the thought panel are addressed to. */
  conversationId?: string;
  /** A turn is in flight. */
  isLoading: boolean;
  /** The conversation's messages are still on their way. */
  conversationLoading?: boolean;
  history?: ThreadHistory;
  /**
   * The message a jump was aimed at, by cursor, or `null` at the present. A window is half before
   * the hit and half after, so landing at its end — which is what following the newest does with
   * any list — leaves the reader twenty messages past the thing they searched for.
   */
  focusCursor?: string | null;
  /**
   * The turn that got no answer. It is told with a toast and a Retry, and the person's message
   * stays in the thread.
   */
  failedTurn?: FailedTurn | null;
  onRetryTurn?: () => void;
  /**
   * Ask for Alia's last reply again. Offered on that reply only, and only once it has finished: an
   * earlier one would throw away every turn after it, and a thread has no branches to keep them in.
   */
  onRegenerate?: (assistantMessageId: string) => void;
  /** Load one of this conversation's questions into the composer to rewrite it. */
  onStartEdit?: (userMessageId: string) => void;
  newConversationOffer?: NewConversationOfferProps;
  /** The run an agent is on for this conversation: in progress, or the card it leaves. */
  agentActivity?: AgentActivityState | null;
  /**
   * A voice call is on. Its composer is the call's controls, so there is nowhere for an edit or a
   * regenerate to go, and reading a reply aloud would talk over it.
   */
  call?: { agentState: AgentState | undefined };
  /** Shown, centred above the composer, while there is nothing to read and nothing on its way. */
  empty?: ReactNode;
  /**
   * Bloom's thread handle, for a jump to a cursor and for a restore: `scrollToEnd`,
   * `scrollToOffset`, and `getScrollView()` for the one thing neither covers.
   */
  threadRef: RefObject<AiChatThreadHandle | null>;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** A conversation read by somebody it was shared with: no votes, no read-aloud, no regenerate. */
  readOnly?: boolean;
}

/** True for a reply with no word and no tool call yet: the thinking indicator's moment. */
function isSilent(message: Message | undefined): boolean {
  if (message === undefined || message.role === 'user') return true;
  return (
    message.role === 'assistant' &&
    messageText(message).length === 0 &&
    (message.toolInvocations?.length ?? 0) === 0
  );
}

function ThreadSkeleton() {
  return (
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
  );
}

/**
 * The conversation's thread: its turns in Bloom's AI Chat thread, the same on the sheet, the
 * screen and the Alia app.
 *
 * It draws a list it is handed and owns what belongs to the list: the window over a long history
 * and the scroll that goes with it (`useTimelineWindow`), the day lines and the seams between an
 * agent's conversations, each turn's actions, the thought panel's selection, and the toast for a
 * turn that failed. What the conversation IS — its messages, the history behind it, the turn in
 * flight — comes in as props from `useConversationThread` and the thread hooks.
 */
export const AliaThread = memo(function AliaThread({
  messages,
  conversationId,
  isLoading,
  conversationLoading = false,
  history: historyProps,
  focusCursor,
  failedTurn = null,
  onRetryTurn,
  onRegenerate,
  onStartEdit,
  newConversationOffer,
  agentActivity,
  call,
  empty,
  threadRef,
  onScroll,
  readOnly = false,
}: AliaThreadProps) {
  const { t } = useLabels();
  const callActive = call !== undefined;
  const voiceThinking = call?.agentState === 'thinking';
  const { messages: pastMessages, loading: loadingHistory = false, loadMore } = historyProps ?? {};

  useFailedTurnToast(failedTurn, onRetryTurn);

  const { rows, live, history, ids, arrived, dayLabels, seamIds, lastReplyIndex, timingOf } =
    useThreadRows({
      messages,
      history: pastMessages,
      conversationId,
      conversationLoading,
    });

  // ── The thought panel: this conversation as it reads it, and opening it on a turn ──
  const thoughtScope = useThoughtScope({
    conversationId,
    messages: live,
    conversationLoading,
    isLoading,
    failedTurn,
  });
  const lastLive = isLoading ? live[live.length - 1] : undefined;
  const runningTurnId =
    lastLive?.role === 'assistant' && (lastLive.toolInvocations?.length ?? 0) > 0
      ? lastLive.id
      : null;
  const openThought = useOpenThought(thoughtScope, history, runningTurnId);

  // ── What a row can do ──
  const vote = useMessageVote();
  const readAloud = useReadAloud(callActive);
  const copy = useCallback((text: string) => copyText(text, t), [t]);
  const actions = useMemo<ThreadActions>(
    () => ({
      copy,
      vote,
      readAloud: readAloud.toggle,
      openThought,
      readOnly,
    }),
    [copy, vote, readAloud.toggle, openThought, readOnly],
  );

  /**
   * Whether the reply at `index` can be asked for again: Alia's last reply, the last thing in the
   * thread (a question after it has its own retry), not the one a failure hangs under, and with a
   * question of this conversation before it to replay.
   */
  const canRegenerate = (message: Message, index: number): boolean => {
    if (onRegenerate === undefined || callActive) return false;
    if (index !== lastReplyIndex || index !== rows.length - 1) return false;
    if (index < history.length || failedTurn?.anchorMessageId === message.id) return false;
    for (let i = index - 1; i >= history.length; i--) {
      if (rows[i]?.role === 'user') return true;
    }
    return false;
  };

  /**
   * The conversation that holds the row at `index`, as the id its own actions address: a vote on
   * an old message belongs to the stretch that ended, not to the one on screen.
   */
  const conversationOf = (index: number): string | undefined =>
    index < history.length ? history[index]?.conversationId : conversationId;

  // ── Which rows are mounted, and the scroll that goes with them ──
  /** The row a cursor jump was aimed at, as an index into what is shown, or -1. */
  const focusIndex = useMemo(
    () =>
      focusCursor === undefined || focusCursor === null
        ? -1
        : history.findIndex((m) => m.cursor === focusCursor),
    [history, focusCursor],
  );

  /**
   * Put the message a jump was aimed at under the reader's eyes, re-applied on every layout of
   * that row: the rows above it settle in installments, so the first position it reports is not
   * the one it keeps. Each call supersedes the last and the final one is right.
   */
  const handleFocusLayout = useCallback(
    (event: LayoutChangeEvent) => {
      threadRef.current?.scrollToOffset({ offset: Math.max(0, event.nativeEvent.layout.y) });
    },
    [threadRef],
  );

  const timeline = useTimelineWindow({
    ids,
    scrollKey: focusCursor == null ? (conversationId ?? null) : null,
    ready: !conversationLoading,
    focusIndex,
    turnInFlight: isLoading,
    atBottomThreshold: AT_BOTTOM_THRESHOLD,
    threadRef,
    onLoadHistory: loadMore,
    onScroll,
  });

  const nothingToShow =
    rows.length === 0 && !conversationLoading && !isLoading && !loadingHistory && !voiceThinking;
  if (nothingToShow) {
    return (
      // Screen reserves the composer; the empty state only owns its alignment.
      <View className="flex-1 justify-center px-4">
        <View className="w-full max-w-[768px] self-center">{empty}</View>
      </View>
    );
  }

  const renderRow = (message: Message, index: number) => {
    const fromHistory = index < history.length;
    const timing = timingOf(message.id);
    const dayLabel = dayLabels.get(message.id);
    const isLastReply = index === lastReplyIndex;
    return (
      <Fragment key={message.id || `row-${index}`}>
        {seamIds.has(message.id) ? <Divider spacing={16}>{t('chat.newStretch')}</Divider> : null}
        {dayLabel === undefined ? null : <ChatDateHeader label={dayLabel} placement="inline" />}
        <ThreadRow
          message={message}
          // Only a message that arrived while this conversation was open animates in; none of the
          // history ever does.
          isNew={!fromHistory && arrived.has(message.id)}
          isLastReply={isLastReply}
          // Only the last reply reads it: handing it to every row would re-render the whole thread
          // when a turn starts and when it ends.
          isLoading={isLastReply ? isLoading : false}
          conversationId={conversationOf(index)}
          onLayout={index === focusIndex ? handleFocusLayout : undefined}
          actions={actions}
          readAloudState={readAloud.stateOf(message.id)}
          readAloudBlocked={readAloud.blocked}
          onRegenerate={canRegenerate(message, index) ? onRegenerate : undefined}
          // A question of an earlier conversation is not in the list an edit cuts, so the "edit"
          // would silently become a new turn.
          onStartEdit={
            message.role === 'user' && !fromHistory && !callActive ? onStartEdit : undefined
          }
          workStartedAt={timing.startedAt}
          workEndedAt={timing.endedAt}
        />
      </Fragment>
    );
  };

  /*
   * Bloom's thread, with the four behaviours Alia's own scroll hook had.
   *
   * `followAnimated={false}` is the one that is not a default: an ANIMATED `scrollToEnd` emits a
   * run of intermediate positions from above the end, and anything reading those as the reader's
   * own scrolling stops following at the first token — the classic autoscroll that switches
   * itself off and looks random. Unanimated there are no intermediate positions, so the trap is
   * unreachable rather than guarded against.
   *
   * `onStartReached` rather than an end-reached: a chat pages UPWARD. `maintainStartPosition`
   * adds the page's growth to the offset so the turn being read does not slide away under it.
   *
   * The keyboard is the container's to handle: Bloom's AI Chat family imports no keyboard
   * controller at all.
   */
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
        {/* The transcript column, centred: a little wider than the composer (896 against its
            768), so the answer has room to breathe. */}
        <View className="w-full max-w-4xl self-center">
          {rows.length === 0 && conversationLoading ? <ThreadSkeleton /> : null}

          <View className="relative" onLayout={timeline.onListLayout}>
            {/* The slot the history loader shows in, held open for as long as there is history to
                load. The thread anchors ONE growth per request — the first after
                `onStartReached` — so a loader that appeared on request would spend that anchor on
                itself and leave the page that follows it to push the reader down. */}
            {loadMore === undefined && !loadingHistory ? null : (
              <View className="h-14 items-center justify-center">
                {loadingHistory ? (
                  <Loading variant="inline" text={t('chat.loadingHistory')} />
                ) : null}
              </View>
            )}
            {rows
              .slice(timeline.start)
              .map((message, offset) => renderRow(message, timeline.start + offset))}
          </View>

          {/* Agent execution — in-progress card or completed result card */}
          {agentActivity && agentActivity.eventCount > 0 ? (
            agentActivity.isComplete ? (
              <AgentResultCard activity={agentActivity} />
            ) : (
              <AgentTaskCard activity={agentActivity} />
            )
          ) : null}

          {/* The agent's offer to start the next stretch fresh. Last in the list on purpose: it
              must not cover what is being read, and ignoring it has to leave the thread exactly as
              it was. */}
          {newConversationOffer === undefined ? null : (
            <NewConversationOffer
              reason={newConversationOffer.reason}
              onAccept={newConversationOffer.onAccept}
              onDismiss={newConversationOffer.onDismiss}
            />
          )}

          {/* Waiting indicator for a call: the agent is thinking but there is no reply to hold it
              yet (right after the person spoke). */}
          {voiceThinking && !isLoading && messages[messages.length - 1]?.role !== 'assistant' ? (
            <AgentThinking variant="wave" label={t('chat.thinking')} showTimer={false} />
          ) : null}

          {/* Bloom's `AgentChat`: while a turn is busy and its reply has no word yet, AgentThinking
              sits under the transcript, in its column. A turn already running tools shows their
              own working line. */}
          {isLoading && isSilent(messages[messages.length - 1]) ? (
            <AgentThinking variant="wave" label={t('chat.thinking')} />
          ) : null}
        </View>
      </AiChatThread>
    </View>
  );
});
