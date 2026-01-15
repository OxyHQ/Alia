import { ScrollView } from "react-native";
import type React from "react";
import { forwardRef, useImperativeHandle, useRef } from "react";
import {
  useWindowDimensions,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";

export interface ScrollAdaptRef {
  scrollRight: (index: number) => void;
}

interface ScrollAdaptProps {
  children: React.ReactNode;
  withSnap?: boolean;
  itemWidth?: number;
  isStudy?: boolean;
}

export const ScrollAdapt = forwardRef<ScrollAdaptRef, ScrollAdaptProps>(
  ({ children, withSnap = false, itemWidth, isStudy = false }, ref) => {
    const { width } = useWindowDimensions();
    const scrollViewRef = useRef<ScrollView>(null);

    useImperativeHandle(ref, () => ({
      scrollRight: (index: number) => {
        if (itemWidth) {
          scrollViewRef.current?.scrollTo({
            x: itemWidth * (index + 1),
            animated: true,
          });
        }
      },
    }));

    const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (isStudy) {
        const currentOffset = event.nativeEvent.contentOffset.x;
        scrollViewRef.current?.scrollTo({ x: currentOffset, animated: false });
      }
    };

    return (
      <ScrollView
        ref={scrollViewRef}
        className="max-h-[120] bg-white pl-3 dark:bg-black"
        horizontal
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        snapToInterval={itemWidth}
        onScroll={isStudy ? handleScroll : undefined}
        scrollEventThrottle={isStudy ? 16 : undefined}
        scrollEnabled={!isStudy}
      >
        {children}
      </ScrollView>
    );
  },
);

ScrollAdapt.displayName = "ScrollAdapt";
