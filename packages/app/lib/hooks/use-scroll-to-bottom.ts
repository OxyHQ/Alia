import { useCallback, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { ScrollView } from "react-native";

/** How near the end still counts as being at the bottom, in px. */
const THRESHOLD = 50;

/**
 * How near the top asks for the page above, in px.
 *
 * A screenful of warning rather than the top itself: asking at zero means the
 * reader waits at a dead end while the request flies, and a thread is read
 * upwards at speed.
 */
const NEAR_TOP = 300;

/**
 * A thread's history, as this hook needs to see it: whether an older page
 * exists, whether one is already coming, and how to ask.
 *
 * Passed as an object and destructured to primitives immediately, so the
 * literal at the call site does not become a new dependency on every render —
 * `onScroll` is a prop of a memoized list that re-renders per streamed token.
 */
interface HistoryPaging {
  hasMore: boolean;
  isLoading: boolean;
  load: () => void;
}

/**
 * Sticky-bottom scrolling: the view follows growing content while the reader is
 * at the end, and lets go the moment they scroll up.
 *
 * It holds the OTHER end too. Reading upwards is what asks a thread for its
 * older stretches, and content inserted above would otherwise slide the message
 * being read out from under the reader — worse, it would leave them near the
 * top again, asking for the next page, and the next, until the whole thread had
 * been pulled in. Asking and holding the position are therefore one thing, and
 * both live here.
 *
 * The follow is driven by `onContentSizeChange` rather than by the message
 * count, because a streamed answer arrives as text appended to the LAST
 * message — the count never changes, only the height does.
 *
 * ## Every programmatic scroll here is unanimated, deliberately
 *
 * `scrollToEnd` emits `onScroll` just as a finger does, and this hook reads
 * `onScroll` as "the reader moved". An ANIMATED scroll emits a run of
 * intermediate events from ABOVE the end, so the first one would be read as the
 * reader scrolling up and switch the follow off at the first token — the classic
 * failure where autoscroll disables itself and looks random.
 *
 * Unanimated, there are no intermediate positions: the one event that follows
 * lands exactly at the end and so reports at-bottom, leaving the follow armed.
 * That makes the trap unreachable by construction rather than guarded against,
 * and it also means any "not at the bottom" event is genuinely the reader.
 * Following an animation instead would fight the reader at sixty tokens a
 * second, and can land short of an end that moved while it glided.
 */
export function useScrollToBottom(
  scrollRef: React.RefObject<ScrollView | null>,
  history?: HistoryPaging,
) {
  const hasMoreHistory = history?.hasMore ?? false;
  const isLoadingHistory = history?.isLoading ?? false;
  const loadHistory = history?.load;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  /** Where the reader is, and how tall the history is, as last seen. */
  const offsetRef = useRef(0);
  const historyEndRef = useRef(0);
  const anchorRef = useRef<{ historyEnd: number; offset: number } | null>(null);
  /** The last position this hook set itself, to tell its own scroll from a finger. */
  const restoredToRef = useRef<number | null>(null);

  const setAtBottom = useCallback((next: boolean) => {
    if (next === isAtBottomRef.current) return;
    isAtBottomRef.current = next;
    setIsAtBottom(next);
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      offsetRef.current = contentOffset.y;
      const distanceFromBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      setAtBottom(distanceFromBottom <= THRESHOLD);

      /**
       * The reader moved, so the anchor is theirs to lose: whatever they are
       * looking at now is where they want to be, and a page that lands later
       * must not drag them back to where they were before they scrolled.
       *
       * Told apart from this hook's OWN scroll by position, which is the only
       * thing that distinguishes them — a programmatic scroll emits exactly the
       * same event a finger does.
       */
      if (
        anchorRef.current !== null &&
        restoredToRef.current !== null &&
        Math.abs(contentOffset.y - restoredToRef.current) > 2
      ) {
        anchorRef.current = null;
      }

      if (loadHistory === undefined || !hasMoreHistory || isLoadingHistory) return;
      /**
       * An armed anchor means a page is still settling into place, and the
       * position this event reports is mid-flight. Asking again from there
       * fetches a page the reader never asked for — and layout arrives in
       * installments, so there are several such events after every load.
       */
      if (anchorRef.current !== null) return;
      if (contentOffset.y > NEAR_TOP) return;
      /**
       * Where the reader is, recorded BEFORE the request rather than when it
       * answers: the page lands above them and shifts everything down, and by
       * then this position no longer describes anything.
       */
      anchorRef.current = { historyEnd: historyEndRef.current, offset: contentOffset.y };
      restoredToRef.current = null;
      loadHistory();
    },
    [setAtBottom, hasMoreHistory, isLoadingHistory, loadHistory]
  );

  /**
   * Content grew. Re-pin only while the reader is at the end — this is the half
   * that keeps a scrolled-up reader where they are, and it opens a thread at its
   * newest message, since the follow starts armed.
   */
  const onContentSizeChange = useCallback(() => {
    if (!isAtBottomRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [scrollRef]);

  /** The manual jump. Arriving at the end re-arms the follow through `onScroll`. */
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [scrollRef]);

  /**
   * How tall the history above the live conversation is, whenever that changes.
   *
   * The history's own height rather than the total content height, and the
   * difference is load-bearing: a streamed answer grows the content at the
   * BOTTOM, and a total-height delta cannot tell that apart from a page landing
   * at the top. Restoring against the wrong one shoves a reader who is scrolled
   * up.
   *
   * ## Re-applied on every measurement, never spent on the first
   *
   * A page does not arrive as one layout. The rows measure in installments, and
   * a correction applied once — to the first of them — leaves the reader short
   * by everything that had not been laid out yet, which is most of the page and
   * puts them right back at the top. So the correction is ABSOLUTE, computed
   * from the same baseline every time, and re-applied as the picture completes:
   * each one supersedes the last and the final one is right.
   *
   * It stays armed afterwards, deliberately. Anything that grows the history
   * later — an image in an old message finishing, a window resize — displaces
   * the reader by exactly the same rule, and the reader's own scroll is what
   * ends it.
   */
  const historyEndsAt = useCallback((height: number) => {
    const anchor = anchorRef.current;
    historyEndRef.current = height;
    if (anchor === null || height === anchor.historyEnd) return;
    const y = anchor.offset + (height - anchor.historyEnd);
    restoredToRef.current = y;
    scrollRef.current?.scrollTo({ y, animated: false });
  }, [scrollRef]);

  return {
    isAtBottom,
    scrollToBottom,
    onScroll,
    onContentSizeChange,
    historyEndsAt,
  };
}
