import * as React from "react";
import { Pressable, Animated } from "react-native";
import { cn } from "@/lib/utils";

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

const Switch = React.forwardRef<React.ElementRef<typeof Pressable>, SwitchProps>(
  ({ value, onValueChange, disabled, className, size = "default" }, ref) => {
    const anim = React.useRef(new Animated.Value(value ? 1 : 0)).current;

    React.useEffect(() => {
      Animated.spring(anim, {
        toValue: value ? 1 : 0,
        useNativeDriver: false,
        friction: 8,
        tension: 60,
      }).start();
    }, [value, anim]);

    const track = TRACK[size];
    const thumb = THUMB[size];
    const travel = track.w - thumb - PADDING * 2;

    const trackBg = anim.interpolate({
      inputRange: [0, 1],
      outputRange: ["#78788029", "#34C759"],
    });

    const thumbX = anim.interpolate({
      inputRange: [0, 1],
      outputRange: [PADDING, PADDING + travel],
    });

    return (
      <Pressable
        ref={ref}
        role="switch"
        aria-checked={value}
        accessibilityState={{ checked: value, disabled }}
        onPress={() => !disabled && onValueChange(!value)}
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
          }}
        >
          <Animated.View
            style={{
              width: thumb,
              height: thumb,
              borderRadius: thumb / 2,
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
