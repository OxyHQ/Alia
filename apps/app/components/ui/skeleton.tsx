import { useEffect, useRef } from "react";
import { Animated, type ViewStyle } from "react-native";

interface SkeletonProps {
  className?: string;
  style?: ViewStyle;
}

export function Skeleton({ className = "", style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return <Animated.View className={`bg-muted rounded ${className}`} style={[style, { opacity }]} />;
}
