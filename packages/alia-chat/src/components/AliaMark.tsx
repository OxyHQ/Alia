import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import Animated, {
  useDerivedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { cn } from '../lib/utils';

export type AliaMarkState = 'idle' | 'thinking' | 'working' | 'writing';

export interface AliaMarkProps {
  /** Width & height in px. Default 24. */
  size?: number;
  /** Animation state — spins while thinking/working, pulses while writing, still when idle. Default 'idle'. */
  state?: AliaMarkState;
  /** Color class on the outer View; the mark inherits via currentColor. Default 'text-foreground'. */
  className?: string;
}

/**
 * Alia brand mark — a six-arm asterisk (✱) rendered as an SVG.
 * Effect-free reanimated: spin while thinking/using tools, opacity-pulse while
 * streaming text, still when idle.
 */
export function AliaMark({ size = 24, state = 'idle', className }: AliaMarkProps) {
  const rotation = useDerivedValue(() =>
    state === 'thinking' || state === 'working'
      ? withRepeat(withTiming(360, { duration: 2000, easing: Easing.linear }), -1)
      : withTiming(0, { duration: 200 }),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    opacity:
      state === 'writing'
        ? withRepeat(
            withSequence(
              withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.ease) }),
              withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
            ),
            -1,
            true,
          )
        : withTiming(1, { duration: 200 }),
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <View className={cn(className ?? 'text-foreground')} style={{ width: size, height: size }}>
      <Animated.View style={animatedStyle}>
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Line x1={50} y1={12} x2={50} y2={88} stroke="currentColor" strokeWidth={14} strokeLinecap="round" />
          <Line x1={17.1} y1={31} x2={82.9} y2={69} stroke="currentColor" strokeWidth={14} strokeLinecap="round" />
          <Line x1={82.9} y1={31} x2={17.1} y2={69} stroke="currentColor" strokeWidth={14} strokeLinecap="round" />
        </Svg>
      </Animated.View>
    </View>
  );
}
