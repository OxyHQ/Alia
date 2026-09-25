import {
  TAIL,
  TOP,
  collapseToTail,
  pinAnchor,
  resolveStart,
  revealAbove,
  sameTimelineShape,
  timelinePositions,
  type TimelineAnchor,
  type TimelinePosition,
} from '@/lib/chat/timeline';
import type { AiChatThreadHandle } from '@oxy.so/bloom/ai-chat';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { Message } from '@/lib/hooks/use-conversations';

/**
 * The list, handed back as the SAME array for as long as only what its
 * messages say has changed (`sameTimelineShape`).
 *
 * The array it returns may hold an older copy of the message being streamed
 * into, so it is for deriving structure — ids, roles, stamps, speakers — and
 * never for drawing text.
 */
export function useTimelineShape<T extends Pick<Message, 'id' | 'role' | 'createdAt' | 'agentInfo'>>(
  list: readonly T[],
): readonly T[] {
  const shape = useRef(list);
  if (!sameTimelineShape(shape.current, list)) shape.current = list;
  return shape.current;
}

interface Options {
  /** Every row's id, in reading order. Keep its identity stable across tokens. */
  ids: readonly string[];
  /**
   * What a saved position belongs to — the conversation — or `null` for a view
   * that is not remembered (a cursor jump's window of the past).
   */
  scrollKey: string | null;
  /** The conversation's messages have loaded; a restore waits for it. */
  ready: boolean;
  /** Index of a cursor jump's target row, or -1. It is always mounted. */
  focusIndex: number;
  /** A turn is streaming; the window is never folded under it. */
  turnInFlight: boolean;
  atBottomThreshold: number;
  threadRef: RefObject<AiChatThreadHandle | null>;
  /** Ask for the page of history above the first loaded row. */
  onLoadHistory?: () => void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/**
 * What is still to be done to the scroll once the rows it needs are laid out.
 * A restore remembers the list it was set against: that list may still be the
 * previous conversation's, and only a list that changed after it can say the
 * saved row is really gone.
 */
type PendingScroll =
  | { kind: 'end' }
  | { kind: 'offset'; position: TimelinePosition; setAgainst: readonly string[] };

/**
 * A restore is waiting for its conversation's rows: the row it was saved
 * against is not on screen, and the list has not changed since it was set. A
 * list that did change without bringing that row back means the row is gone
 * (edited away, regenerated), and the restore falls back to the newest turn.
 */
function awaitingRows(pending: { current: PendingScroll | null }, ids: readonly string[]): boolean {
  const todo = pending.current;
  if (todo?.kind !== 'offset' || ids.includes(todo.position.probeId)) return false;
  if (ids === todo.setAgainst) return true;
  pending.current = { kind: 'end' };
  return false;
}

/** The state before the first key: nothing mounted yet, so nothing to remember. */
const MOUNTING = Symbol('mounting');

const nextFrame = (run: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
};

/**
 * Which rows the thread mounts, and the scroll that goes with them: the window
 * over a long history, and the position a conversation is returned to.
 *
 * ## The window
 *
 * The newest `INITIAL_ROWS` rows mount first. Near the top, Bloom's
 * `onStartReached` reveals `PAGE_ROWS` more — or, with none left, asks for the
 * thread's history — and `maintainStartPosition` holds the reader on the row
 * they were reading while either lands above. The window folds back to its
 * opening size only when the reader is at the bottom and nothing is streaming.
 * See `lib/chat/timeline.ts` for why it is this and not virtualization.
 *
 * ## The position
 *
 * Leaving a conversation — by navigating away or by switching the screen to
 * another — saves the offset, whether the reader was at the bottom, and the
 * window's anchor. Coming back restores the anchor first, so the same rows are
 * mounted above the reader, and the offset once they have laid out. Coming
 * back from a cursor jump does not restore: "back to latest" means the latest.
 */
export function useTimelineWindow({
  ids,
  scrollKey,
  ready,
  focusIndex,
  turnInFlight,
  atBottomThreshold,
  threadRef,
  onLoadHistory,
  onScroll,
}: Options) {
  const [state, setState] = useState<{ key: string | null; anchor: TimelineAnchor }>({
    key: scrollKey,
    anchor: TAIL,
  });
  // The render after a key change and before its effect: the new conversation
  // starts from the newest rows until the effect says otherwise.
  const anchor = state.key === scrollKey ? state.anchor : TAIL;
  const start = useMemo(() => resolveStart(anchor, ids, focusIndex), [anchor, ids, focusIndex]);

  const setAnchor = useCallback(
    (next: TimelineAnchor) => setState((current) => ({ key: current.key, anchor: next })),
    [],
  );

  /** This render's facts, for callbacks and cleanups that outlive it. */
  const latest = useRef({ ids, start, anchor, ready, turnInFlight, onLoadHistory });
  useLayoutEffect(() => {
    latest.current = { ids, start, anchor, ready, turnInFlight, onLoadHistory };
  });

  /** The last position the thread reported for the current key. */
  const lastOffset = useRef<number | null>(null);
  const atBottom = useRef(true);
  const pending = useRef<PendingScroll | null>(null);
  const previousKey = useRef<string | null | typeof MOUNTING>(MOUNTING);

  useLayoutEffect(() => {
    const cameFrom = previousKey.current;
    previousKey.current = scrollKey;
    lastOffset.current = null;
    atBottom.current = true;
    // Returning from a jump is a request for the present, not for the past.
    // A reader who left from the bottom comes back to the newest page, which
    // is where they were; only a position mid-thread brings its rows back.
    const read =
      scrollKey !== null && cameFrom !== null ? timelinePositions.read(scrollKey) : undefined;
    const saved = read?.atBottom === false ? read : undefined;
    pending.current =
      scrollKey === null
        ? null
        : saved === undefined
          ? { kind: 'end' }
          : { kind: 'offset', position: saved, setAgainst: ids };
    setState({ key: scrollKey, anchor: saved?.anchor ?? TAIL });

    return () => {
      if (scrollKey === null) return;
      const { ids: rows, start: first, anchor: kept } = latest.current;
      if (rows.length === 0) return;
      timelinePositions.save(scrollKey, {
        anchor: kept,
        offset: lastOffset.current ?? 0,
        atBottom: atBottom.current,
        probeId: rows[first],
      });
    };
  }, [scrollKey]);

  /**
   * Pin the opening window to its first row once the rows exist, so a turn
   * appended at the bottom grows the window rather than sliding it — a slide
   * would unmount the top row under a reader who is mid-thread. Re-pinned the
   * same way when the pinned row has gone (the list was replaced) — except
   * while a restore waits for its conversation's rows: the rows on screen are
   * still the last conversation's, and the anchor being restored is not in
   * them yet.
   */
  useLayoutEffect(() => {
    if (ids.length === 0 || awaitingRows(pending, ids)) return;
    const stale = anchor.kind === 'tail' || (anchor.kind === 'row' && !ids.includes(anchor.id));
    if (!stale) return;
    setState((current) =>
      current.key === scrollKey && current.anchor === anchor
        ? { key: current.key, anchor: pinAnchor(ids, start) }
        : current,
    );
  }, [ids, anchor, start, scrollKey]);

  const handleStartReached = useCallback(() => {
    const { ids: rows, start: first, onLoadHistory: loadHistory } = latest.current;
    const next = revealAbove(rows, first);
    if (next !== null) {
      setAnchor(next);
      return;
    }
    setAnchor(TOP);
    loadHistory?.();
  }, [setAnchor]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      lastOffset.current = contentOffset.y;
      const wasAtBottom = atBottom.current;
      atBottom.current =
        contentSize.height - contentOffset.y - layoutMeasurement.height <= atBottomThreshold;
      if (atBottom.current && !wasAtBottom && !latest.current.turnInFlight) {
        const { ids: rows, start: first } = latest.current;
        const folded = collapseToTail(rows, first);
        if (folded !== null) {
          pending.current = { kind: 'end' };
          setAnchor(folded);
        }
      }
      onScroll?.(event);
    },
    [atBottomThreshold, onScroll, setAnchor],
  );

  /**
   * The rows have laid out: carry out whatever scroll was waiting for them.
   * A frame later, so it lands after the thread's own reaction to the same
   * layout (on web it follows to the end on its first one).
   */
  const handleListLayout = useCallback(
    (_event: LayoutChangeEvent) => {
      const { ids: rows, ready: loaded } = latest.current;
      if (pending.current === null || !loaded || rows.length === 0) return;
      if (awaitingRows(pending, rows)) return;
      const todo = pending.current;
      pending.current = null;
      nextFrame(() => {
        if (todo.kind === 'end') threadRef.current?.scrollToEnd({ animated: false });
        else threadRef.current?.scrollToOffset({ offset: todo.position.offset });
      });
    },
    [threadRef],
  );

  return {
    /** Index of the first mounted row. */
    start,
    /** For `AiChatThread`: absent when there is nothing above to reveal or load. */
    onStartReached: start > 0 || onLoadHistory !== undefined ? handleStartReached : undefined,
    onScroll: handleScroll,
    onListLayout: handleListLayout,
  };
}
