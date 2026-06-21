import React, { useEffect } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  Easing,
} from "react-native-reanimated";

export type LoaderProps = {
  variant?:
    | "circular"
    | "pulse"
    | "pulse-dot"
    | "dots"
    | "typing"
    | "wave"
    | "bars"
    | "terminal"
    | "text-blink"
    | "text-shimmer"
    | "loading-dots";
  size?: "sm" | "md" | "lg";
  text?: string;
  className?: string;
};

// --- Circular ---

function CircularLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const dimensions = { sm: 16, md: 20, lg: 24 };
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 800, easing: Easing.linear }),
      -1
    );
  }, [rotation]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const d = dimensions[size];
  return (
    <Animated.View
      style={[spinStyle, { width: d, height: d }]}
      className={cn("rounded-full border-2 border-primary border-t-transparent", className)}
      accessibilityLabel="Loading"
    />
  );
}

// --- Pulse ---

function PulseLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const dimensions = { sm: 16, md: 20, lg: 24 };
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.2, { duration: 750 }),
        withTiming(1, { duration: 750 })
      ),
      -1
    );
  }, [scale]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const d = dimensions[size];
  return (
    <Animated.View
      style={[pulseStyle, { width: d, height: d }]}
      className={cn("rounded-full border-2 border-primary", className)}
      accessibilityLabel="Loading"
    />
  );
}

// --- PulseDot ---

function PulseDotLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const dimensions = { sm: 4, md: 8, lg: 12 };
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.5, { duration: 600 }),
        withTiming(1, { duration: 600 })
      ),
      -1
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.4, { duration: 600 }),
        withTiming(1, { duration: 600 })
      ),
      -1
    );
  }, [scale, opacity]);

  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const d = dimensions[size];
  return (
    <Animated.View
      style={[dotStyle, { width: d, height: d }]}
      className={cn("rounded-full bg-primary", className)}
      accessibilityLabel="Loading"
    />
  );
}

// --- Animated Dot (shared for Dots and Typing) ---

function AnimatedDot({
  delay,
  dotSize,
  animType,
}: {
  delay: number;
  dotSize: number;
  animType: "bounce" | "opacity";
}) {
  const value = useSharedValue(animType === "bounce" ? 0 : 0.3);

  useEffect(() => {
    if (animType === "bounce") {
      value.value = withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(-dotSize, { duration: 350, easing: Easing.out(Easing.ease) }),
            withTiming(0, { duration: 350, easing: Easing.in(Easing.ease) })
          ),
          -1
        )
      );
    } else {
      value.value = withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(1, { duration: 500 }),
            withTiming(0.3, { duration: 500 })
          ),
          -1
        )
      );
    }
  }, [value, delay, dotSize, animType]);

  const style = useAnimatedStyle(() =>
    animType === "bounce"
      ? { transform: [{ translateY: value.value }] }
      : { opacity: value.value }
  );

  return (
    <Animated.View
      style={[style, { width: dotSize, height: dotSize }]}
      className="rounded-full bg-primary"
    />
  );
}

// --- Dots ---

function DotsLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const dotSizes = { sm: 6, md: 8, lg: 10 };
  const d = dotSizes[size];

  return (
    <View
      className={cn("flex-row items-center gap-1", className)}
      accessibilityLabel="Loading"
    >
      {[0, 1, 2].map((i) => (
        <AnimatedDot key={i} delay={i * 160} dotSize={d} animType="bounce" />
      ))}
    </View>
  );
}

// --- Typing ---

function TypingLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const dotSizes = { sm: 4, md: 6, lg: 8 };
  const d = dotSizes[size];

  return (
    <View
      className={cn("flex-row items-center gap-1", className)}
      accessibilityLabel="Loading"
    >
      {[0, 1, 2].map((i) => (
        <AnimatedDot key={i} delay={i * 250} dotSize={d} animType="opacity" />
      ))}
    </View>
  );
}

// --- Animated Bar (shared for Wave and Bars) ---

function AnimatedBar({
  delay,
  width,
  baseHeight,
  maxHeight,
}: {
  delay: number;
  width: number;
  baseHeight: number;
  maxHeight: number;
}) {
  const height = useSharedValue(baseHeight);

  useEffect(() => {
    height.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(maxHeight, { duration: 400, easing: Easing.inOut(Easing.ease) }),
          withTiming(baseHeight, { duration: 400, easing: Easing.inOut(Easing.ease) })
        ),
        -1
      )
    );
  }, [height, delay, baseHeight, maxHeight]);

  const barStyle = useAnimatedStyle(() => ({
    height: height.value,
    width,
  }));

  return <Animated.View style={barStyle} className="rounded-full bg-primary" />;
}

// --- Wave ---

function WaveLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const barWidth = { sm: 2, md: 2, lg: 4 };
  const heights = {
    sm: [6, 9, 12, 9, 6],
    md: [8, 12, 16, 12, 8],
    lg: [10, 15, 20, 15, 10],
  };

  const w = barWidth[size];
  const h = heights[size];
  const minH = Math.min(...h);
  const maxH = Math.max(...h);

  return (
    <View
      className={cn("flex-row items-center gap-0.5", className)}
      accessibilityLabel="Loading"
    >
      {h.map((baseH, i) => (
        <AnimatedBar
          key={i}
          delay={i * 100}
          width={w}
          baseHeight={baseH === maxH ? minH : baseH}
          maxHeight={baseH}
        />
      ))}
    </View>
  );
}

// --- Bars ---

function BarsLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const barWidths = { sm: 4, md: 6, lg: 8 };
  const containerHeights = { sm: 16, md: 20, lg: 24 };

  const w = barWidths[size];
  const maxH = containerHeights[size];

  return (
    <View
      className={cn("flex-row items-end gap-1", className)}
      style={{ height: maxH }}
      accessibilityLabel="Loading"
    >
      {[0, 1, 2].map((i) => (
        <AnimatedBar
          key={i}
          delay={i * 200}
          width={w}
          baseHeight={maxH * 0.3}
          maxHeight={maxH}
        />
      ))}
    </View>
  );
}

// --- Terminal ---

function TerminalLoader({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const cursorDimensions = {
    sm: { h: 12, w: 6 },
    md: { h: 16, w: 8 },
    lg: { h: 20, w: 10 },
  };
  const textSizes = { sm: "text-xs", md: "text-sm", lg: "text-base" } as const;

  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 0 }),
        withDelay(500, withTiming(0, { duration: 0 }))
      ),
      -1
    );
  }, [opacity]);

  const blinkStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const { h, w } = cursorDimensions[size];

  return (
    <View
      className={cn("flex-row items-center gap-1", className)}
      accessibilityLabel="Loading"
    >
      <Text className={cn("text-primary font-mono", textSizes[size])}>
        {">"}
      </Text>
      <Animated.View
        style={[blinkStyle, { height: h, width: w }]}
        className="bg-primary"
      />
    </View>
  );
}

// --- TextBlink ---

function TextBlinkLoader({
  text = "Thinking",
  className,
  size = "md",
}: {
  text?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const textSizes = { sm: "text-xs", md: "text-sm", lg: "text-base" } as const;
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 1000 }),
        withTiming(1, { duration: 1000 })
      ),
      -1
    );
  }, [opacity]);

  const blinkStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={blinkStyle} className={cn("", className)}>
      <Text className={cn("font-medium text-foreground", textSizes[size])}>
        {text}
      </Text>
    </Animated.View>
  );
}

// --- TextShimmer (pulse-based for now, will connect to TextShimmer component later) ---

function TextShimmerLoader({
  text = "Thinking",
  className,
  size = "md",
}: {
  text?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const textSizes = { sm: "text-xs", md: "text-sm", lg: "text-base" } as const;
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1200 }),
        withTiming(0.5, { duration: 1200 })
      ),
      -1
    );
  }, [opacity]);

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={shimmerStyle} className={cn("", className)}>
      <Text className={cn("font-medium text-muted-foreground", textSizes[size])}>
        {text}
      </Text>
    </Animated.View>
  );
}

// --- TextDots ---

function AnimatedTextDot({ delay }: { delay: number }) {
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 300 }),
          withTiming(0, { duration: 300 }),
          withDelay(500, withTiming(0, { duration: 0 }))
        ),
        -1
      )
    );
  }, [opacity, delay]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.Text style={style} className="text-primary font-medium">
      .
    </Animated.Text>
  );
}

function TextDotsLoader({
  className,
  text = "Thinking",
  size = "md",
}: {
  className?: string;
  text?: string;
  size?: "sm" | "md" | "lg";
}) {
  const textSizes = { sm: "text-xs", md: "text-sm", lg: "text-base" } as const;

  return (
    <View className={cn("flex-row items-center", className)}>
      <Text className={cn("text-primary font-medium", textSizes[size])}>
        {text}
      </Text>
      <View className="flex-row">
        <AnimatedTextDot delay={200} />
        <AnimatedTextDot delay={400} />
        <AnimatedTextDot delay={600} />
      </View>
    </View>
  );
}

// --- Main Loader ---

function Loader({ variant = "circular", size = "md", text, className }: LoaderProps) {
  switch (variant) {
    case "circular":
      return <CircularLoader size={size} className={className} />;
    case "pulse":
      return <PulseLoader size={size} className={className} />;
    case "pulse-dot":
      return <PulseDotLoader size={size} className={className} />;
    case "dots":
      return <DotsLoader size={size} className={className} />;
    case "typing":
      return <TypingLoader size={size} className={className} />;
    case "wave":
      return <WaveLoader size={size} className={className} />;
    case "bars":
      return <BarsLoader size={size} className={className} />;
    case "terminal":
      return <TerminalLoader size={size} className={className} />;
    case "text-blink":
      return <TextBlinkLoader text={text} size={size} className={className} />;
    case "text-shimmer":
      return <TextShimmerLoader text={text} size={size} className={className} />;
    case "loading-dots":
      return <TextDotsLoader text={text} size={size} className={className} />;
    default:
      return <CircularLoader size={size} className={className} />;
  }
}

export {
  Loader,
  CircularLoader,
  PulseLoader,
  PulseDotLoader,
  DotsLoader,
  TypingLoader,
  WaveLoader,
  BarsLoader,
  TerminalLoader,
  TextBlinkLoader,
  TextShimmerLoader,
  TextDotsLoader,
};
