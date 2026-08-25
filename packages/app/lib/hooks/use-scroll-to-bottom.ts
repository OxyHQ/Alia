import { useCallback, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { ScrollView } from "react-native";

/** How near the end still counts as being at the bottom, in px. */
const THRESHOLD = 50;

/**
 * Sticky-bottom scrolling: the view follows growing content while the reader is
 * at the end, and lets go the moment they scroll up.
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
export function useScrollToBottom(scrollRef: React.RefObject<ScrollView | null>) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  const setAtBottom = useCallback((next: boolean) => {
    if (next === isAtBottomRef.current) return;
    isAtBottomRef.current = next;
    setIsAtBottom(next);
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      setAtBottom(distanceFromBottom <= THRESHOLD);
    },
    [setAtBottom]
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

  return {
    isAtBottom,
    scrollToBottom,
    onScroll,
    onContentSizeChange,
  };
}
