import { View } from "react-native";
import * as Skeleton from "@oxy.so/bloom/skeleton";

/**
 * The six ghost rows the sidebar shows while the conversation list loads.
 *
 * The widths are deliberately uneven — `60 / 75 / 90%` cycling by index — so
 * the stack reads as a list of titles of different lengths rather than as six
 * identical bars, which is the tell that makes a placeholder look like a
 * progress bar instead of content.
 *
 * Bloom's `Skeleton` is a namespace of SHAPES (`Circle`, `Box`, `Pill`,
 * `Text`), not one box that takes a className, so the avatar dot says
 * `Circle` and the title lines say `Box`. That is the whole reason the
 * wrapper this replaced existed: it was a single `Animated.View` with
 * `bg-muted` and whatever Tailwind the call site felt like, which meant every
 * skeleton in the app had its own shimmer timing baked into its own copy of
 * the same loop.
 */
export function SidebarSkeleton() {
  return (
    <View className="gap-2 px-2 py-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} className="flex-row items-center gap-2.5 py-1.5">
          <Skeleton.Circle size={20} />
          <View className="flex-1 gap-1.5">
            <Skeleton.Box height={12} borderRadius={4} style={{ width: `${60 + (i % 3) * 15}%` }} />
            <Skeleton.Box width="40%" height={10} borderRadius={4} />
          </View>
        </View>
      ))}
    </View>
  );
}
