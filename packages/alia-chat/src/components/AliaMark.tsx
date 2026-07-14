import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { Text } from './ui/text';
import { cn } from '../lib/utils';

export type AliaMarkState = 'idle' | 'thinking' | 'working' | 'writing';

export interface AliaMarkProps {
  /** Width & height in px. Default 24. */
  size?: number;
  /** Animation state — spins while thinking/working, opacity-pulses while writing, still when idle. Default 'idle'. */
  state?: AliaMarkState;
  /** NativeWind text color class for the glyph. Default 'text-foreground'. */
  className?: string;
}

/**
 * Alia brand mark — the spinning asterisk (✱), mirrored from Codea's conversation glyph.
 * Effect-free reanimated: spin while thinking/using tools, opacity-pulse while
 * streaming text, still when idle.
 */
export function AliaMark({ size = 24, state = 'idle', className }: AliaMarkProps) {
  // Imperative animations via reanimated's reactive primitive (NOT a React effect):
  // on this reanimated-web setup, animations returned from mappers/styles never
  // tick, but `sharedValue.value = withRepeat(...)` does.
  const rotation = useSharedValue(0);
  useAnimatedReaction(
    () => state === 'thinking' || state === 'working',
    (spinning, previous) => {
      if (spinning === previous) return;
      if (spinning) {
        rotation.value = 0;
        rotation.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1);
      } else {
        cancelAnimation(rotation);
        rotation.value = withTiming(0, { duration: 200 });
      }
    },
    [state],
  );

  const opacity = useSharedValue(1);
  useAnimatedReaction(
    () => state === 'writing',
    (pulsing, previous) => {
      if (pulsing === previous) return;
      if (pulsing) {
        opacity.value = withRepeat(
          withSequence(
            withTiming(0.5, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
            withTiming(1, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
          ),
          -1,
        );
      } else {
        cancelAnimation(opacity);
        opacity.value = withTiming(1, { duration: 200 });
      }
    },
    [state],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={animatedStyle}>
        <Text
          selectable={false}
          className={cn(className ?? 'text-foreground')}
          style={{ fontSize: size, lineHeight: size, userSelect: 'none' }}
        >
          ✱
        </Text>
      </Animated.View>
    </View>
  );
}
