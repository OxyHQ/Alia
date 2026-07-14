import * as React from "react";
import { Pressable, Animated } from "react-native";
import { cn } from "@/lib/utils";
import { useTheme, withAlpha } from "@oxyhq/bloom/theme";

interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
  size?: "default" | "sm";
}

const TRACK = { default: { w: 44, h: 26 }, sm: { w: 36, h: 22 } } as const;
const THUMB = { default: 22, sm: 18 } as const;
const PADDING = 2;
const SQUEEZE_RATIO = 0.75; // thumb height shrinks to 75% when pressed

const Switch = React.forwardRef<React.ElementRef<typeof Pressable>, SwitchProps>(
  ({ value, onValueChange, disabled, className, size = "default" }, ref) => {
    const { colors } = useTheme();
    const anim = React.useRef(new Animated.Value(value ? 1 : 0)).current;
    const pressAnim = React.useRef(new Animated.Value(0)).current;

    React.useEffect(() => {
      Animated.spring(anim, {
        toValue: value ? 1 : 0,
        useNativeDriver: false,
        friction: 8,
        tension: 60,
      }).start();
    }, [value, anim]);

    const onPressIn = () => {
      if (disabled) return;
      Animated.spring(pressAnim, {
        toValue: 1,
        useNativeDriver: false,
        friction: 8,
        tension: 100,
      }).start();
    };

    const onPressOut = () => {
      Animated.spring(pressAnim, {
        toValue: 0,
        useNativeDriver: false,
        friction: 8,
        tension: 60,
      }).start();
    };

    const track = TRACK[size];
    const thumb = THUMB[size];
    const travel = track.w - thumb - PADDING * 2;

    const trackBg = anim.interpolate({
      inputRange: [0, 1],
      outputRange: [withAlpha(colors.text, 0.16), colors.primary],
    });

    const thumbX = anim.interpolate({
      inputRange: [0, 1],
      outputRange: [PADDING, PADDING + travel],
    });

    const squeezedHeight = thumb * SQUEEZE_RATIO;

    const thumbHeight = pressAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [thumb, squeezedHeight],
    });

    const thumbRadius = pressAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [thumb / 2, squeezedHeight / 2],
    });

    return (
      <Pressable
        ref={ref}
        role="switch"
        aria-checked={value}
        accessibilityState={{ checked: value, disabled }}
        onPress={() => !disabled && onValueChange(!value)}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        className={cn(disabled && "opacity-40", className)}
        hitSlop={4}
      >
        <Animated.View
          style={{
            width: track.w,
            height: track.h,
            borderRadius: track.h / 2,
            backgroundColor: trackBg,
            justifyContent: "center",
            alignItems: "flex-start",
          }}
        >
          <Animated.View
            style={{
              width: thumb,
              height: thumbHeight,
              borderRadius: thumbRadius,
              backgroundColor: "#fff",
              transform: [{ translateX: thumbX }],
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.15,
              shadowRadius: 3,
              elevation: 3,
            }}
          />
        </Animated.View>
      </Pressable>
    );
  }
);

Switch.displayName = "Switch";

export { Switch };
export type { SwitchProps };
