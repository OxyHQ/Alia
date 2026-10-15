import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLabels } from '../lib/labels';
import {
  type Message,
  type ThreadMessage,
  arrivedIds,
  daySeparators,
  threadSeamIds,
  turnTimings,
} from '../runtime/model';
import { useTimelineShape } from './useTimelineWindow';

/** The history of a conversation that has none, as ONE array: a fresh `[]` per render would break every memo. */
const NO_HISTORY: ThreadMessage[] = [];

/** For a row the timings map has never heard of: a shared frozen object keeps memoised rows still. */
const EMPTY_TIMING = Object.freeze({ startedAt: null, endedAt: null });

/** True for Alia's own replies (a delegated agent's are not). */
function isAliaReply(message: Message): boolean {
  return message.role === 'assistant' && !message.agentInfo;
}

export interface UseThreadRowsOptions {
  /** The conversation being streamed into. */
  messages: readonly Message[];
  /** Everything said in the thread before it, oldest first. Empty where nothing is behind it. */
  history: readonly ThreadMessage[] | undefined;
  /** The conversation being streamed into: where the seam between the history and the live rows falls. */
  conversationId: string | undefined;
  /** The conversation's messages are still on their way. */
  conversationLoading: boolean;
}

/**
 * What the thread draws, derived once per change of its STRUCTURE.
 *
 * The live list as ids, roles, stamps and speakers is what a streamed token never changes, so
 * everything derived from the whole thread (day lines, seams, turn timings, the last answer of
 * Alia's, the window's ids) is keyed on that rather than on the messages: a token re-derives
 * nothing, it re-renders the row it was written into and that is all.
 */
export function useThreadRows({
  messages,
  history: historyMessages,
  conversationId,
  conversationLoading,
}: UseThreadRowsOptions) {
  const { t, locale } = useLabels();
  const history = historyMessages ?? NO_HISTORY;

  const live = useMemo(
    () => messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
    [messages],
  );

  /**
   * Everything on screen, in reading order: the history first, the conversation being streamed
   * into after it. Every position below — which row is last, which is the last of Alia's — is an
   * index into THIS, not into the live messages.
   */
  const rows = useMemo<Message[]>(
    () => (history.length === 0 ? live : [...history, ...live]),
    [history, live],
  );

  const liveShape = useTimelineShape(live);
  const shape = useMemo<readonly Message[]>(
    () => (history.length === 0 ? liveShape : [...history, ...liveShape]),
    [history, liveShape],
  );
  const ids = useMemo(() => shape.map((m) => m.id), [shape]);

  /**
   * The live rows that arrived since the last change to the list, which are the only ones that
   * animate in. A history row never does, and neither does a conversation that was loaded or
   * switched to (`arrivedIds`).
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
    previousLive.current = { ids: liveShape.map((m) => m.id), loading: conversationLoading };
  }, [liveShape, conversationLoading]);

  /**
   * Every turn's start and end, computed once for the whole thread: asked per row it is O(n²), and
   * this list re-renders roughly twenty times a second while an answer streams.
   */
  const timings = useMemo(() => turnTimings(shape), [shape]);

  /** The day each message starts, when it starts a new one: Bloom's inline date line above it. */
  const dayLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const { messageId, label } of daySeparators(shape, new Date(), locale)) {
      labels.set(
        messageId,
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
   * Where one conversation of a thread ends and the next begins: the model was given a fresh
   * context there, and everything above is out of its sight (`threadSeamIds`).
   */
  const seamIds = useMemo(
    () => threadSeamIds(history, liveShape, conversationId ?? ''),
    [history, liveShape, conversationId],
  );

  const timingOf = useCallback(
    (messageId: string) => timings.get(messageId) ?? EMPTY_TIMING,
    [timings],
  );

  const lastReplyIndex = useMemo(
    () => shape.reduce((acc, m, i) => (isAliaReply(m) ? i : acc), -1),
    [shape],
  );

  return {
    rows,
    live,
    history,
    ids,
    arrived,
    dayLabels,
    seamIds,
    lastReplyIndex,
    timingOf,
  };
}
