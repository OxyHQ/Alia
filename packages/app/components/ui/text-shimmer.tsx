import React, { useEffect } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

export type TextShimmerProps = {
  children: React.ReactNode;
  duration?: number;
  spread?: number;
  className?: string;
};

export function TextShimmer({
  children,
  duration = 4,
  spread = 20,
  className,
}: TextShimmerProps) {
  const translateX = useSharedValue(-1);

  useEffect(() => {
    translateX.value = withRepeat(
      withTiming(1, { duration: duration * 1000, easing: Easing.linear }),
      -1
    );
  }, [translateX, duration]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: `${translateX.value * 100}%` as any }],
  }));

  const dynamicSpread = Math.min(Math.max(spread, 5), 45) / 100;
  const start = 0.5 - dynamicSpread;
  const end = 0.5 + dynamicSpread;

  return (
    <MaskedView
      maskElement={
        <View>
          {typeof children === "string" ? (
            <Text className={cn("font-medium", className)}>{children}</Text>
          ) : (
            children
          )}
        </View>
      }
    >
      <View style={{ position: "relative" }}>
        {/* Invisible text to size the container */}
        <View style={{ opacity: 0 }}>
          {typeof children === "string" ? (
            <Text className={cn("font-medium", className)}>{children}</Text>
          ) : (
            children
          )}
        </View>
        {/* Animated gradient overlay */}
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 0,
              left: "-100%",
              right: "-100%",
              bottom: 0,
            },
            animatedStyle,
          ]}
        >
          <LinearGradient
            colors={["#737373", "#ffffff", "#737373"]}
            locations={[start, 0.5, end]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      </View>
    </MaskedView>
  );
}
