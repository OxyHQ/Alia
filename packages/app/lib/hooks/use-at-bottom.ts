import { useCallback, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import { AT_BOTTOM_THRESHOLD } from "@/components/chat-interface";

/**
 * Whether the reader is at the end of the thread, for the jump-to-present
 * button.
 *
 * ## What this replaced
 *
 * `use-scroll-to-bottom.ts`, 183 lines, which owned four things at once: the
 * sticky follow, the upward pagination trigger, the anchor that held the
 * reader's position while a page landed above them, and this. Bloom's
 * `AiChatThread` owns the first three now — `followThreshold`,
 * `onStartReached` and `maintainStartPosition`, added in 3.3.0 for exactly
 * this adoption — and it implements them the same way, measuring the threshold
 * against the height BEFORE the growth and adding a landed page's delta to the
 * offset.
 *
 * What Bloom does NOT answer is this question, because it is the host's: a
 * thread has no opinion about whether something should float over it offering
 * to jump. So the one piece that did not move is the one that was never
 * Bloom's.
 *
 * ## Why it is a ref plus a coarse boolean
 *
 * `onScroll` fires at 16ms while an answer streams, and this feeds a button
 * that has exactly two appearances. Setting state on every event would
 * re-render the whole screen sixty times a second to change nothing; the ref
 * holds the live number and the state changes only when the ANSWER changes.
 */
export function useAtBottom(threshold: number = AT_BOTTOM_THRESHOLD) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const atBottom = useRef(true);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
      const next = distance <= threshold;
      if (next === atBottom.current) return;
      atBottom.current = next;
      setIsAtBottom(next);
    },
    [threshold],
  );

  return { isAtBottom, onScroll };
}
