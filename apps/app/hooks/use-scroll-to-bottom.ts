import { useCallback, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, LayoutChangeEvent } from "react-native";
import type { ScrollView } from "react-native";

const THRESHOLD = 50;

export function useScrollToBottom(scrollRef: React.RefObject<ScrollView | null>) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const contentHeightRef = useRef(0);
  const scrollHeightRef = useRef(0);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    setIsAtBottom(distanceFromBottom <= THRESHOLD);
    contentHeightRef.current = contentSize.height;
    scrollHeightRef.current = layoutMeasurement.height;
  }, []);

  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      contentHeightRef.current = h;
      const distanceFromBottom = h - scrollHeightRef.current;
      if (distanceFromBottom <= THRESHOLD) {
        setIsAtBottom(true);
      }
    },
    []
  );

  const scrollToBottom = useCallback(
    (animated = true) => {
      scrollRef.current?.scrollToEnd({ animated });
    },
    [scrollRef]
  );

  return {
    isAtBottom,
    scrollToBottom,
    onScroll,
    onContentSizeChange,
  };
}
