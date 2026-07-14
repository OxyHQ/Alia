import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
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

export type AliaMarkState = 'idle' | 'thinking' | 'working' | 'writing';

export interface AliaMarkProps {
  /** Width & height in px. Default 24. */
  size?: number;
  /** Animation state — spins while thinking/working, opacity-pulses while writing, still when idle. Default 'idle'. */
  state?: AliaMarkState;
  /** Layout classes for the outer box (color comes from `color`, not classes). */
  className?: string;
  /** Glyph fill. Defaults to the Alia brand purple — never a theme token. */
  color?: string;
}

/** Alia brand purple — the mark keeps its identity color across themes. */
const BRAND_FILL = '#d269e6';

/**
 * Square viewBox centered on the glyph (exact curve bounds sampled from the
 * path: x 140.6–1359.6, y 74.4–1425.0), so the mark renders margin-free at any
 * size without distortion.
 */
const VIEWBOX = '74.8 74.4 1350.6 1350.6';

const GLYPH_PATH =
  'M 728 76.199219 C 659.800781 84 596.601562 133.199219 558.800781 207.199219 C 539.800781 244.601562 527.199219 292.398438 524.601562 336.398438 L 523.398438 357.800781 L 506.199219 349 C 457.398438 324.199219 413.601562 313.398438 361 313.199219 C 314.601562 313 281.800781 320 247.199219 337.199219 C 194.398438 363.601562 161 404.601562 145.800781 461.199219 C 140.199219 482.199219 139.601562 527.398438 144.601562 550.199219 C 156.199219 601.800781 182 649.199219 220.601562 689.398438 C 239.800781 709.199219 271 734.601562 287.800781 744 C 292.199219 746.601562 296 749.199219 296 749.800781 C 296 750.398438 292.398438 753 288 755.601562 C 270.800781 765.398438 240 790.601562 221 810.398438 C 137.199219 897.398438 116.601562 1013 170.199219 1095.199219 C 200.199219 1141.199219 247.601562 1171.199219 309 1183.199219 C 333.601562 1188 383.800781 1188 410.800781 1183.199219 C 444 1177.199219 474.398438 1167 505.800781 1151.199219 L 524 1142 L 524 1153.601562 C 524 1180.398438 530.800781 1218.601562 541.199219 1250 C 582.800781 1376 690 1446.800781 796.800781 1419 C 846.398438 1406 893.800781 1369.800781 926 1320 C 953.601562 1277.199219 972.199219 1218.398438 975.398438 1163.601562 L 976.601562 1142.398438 L 994.398438 1151.398438 C 1044.800781 1176.601562 1087.800781 1187 1142 1186.800781 C 1192.601562 1186.601562 1229.601562 1177.199219 1269 1154.199219 C 1289.601562 1142.199219 1319.800781 1112.398438 1331.800781 1092.398438 C 1351.398438 1059.800781 1358.398438 1033.800781 1358.601562 994 C 1358.800781 953.199219 1353.199219 929.398438 1334 888.601562 C 1310.800781 839.601562 1265.398438 789 1217.601562 759.398438 C 1210.199219 754.800781 1204 750.601562 1204 750 C 1204 749.398438 1210.199219 745.199219 1217.601562 740.601562 C 1251.398438 719.601562 1291 681.199219 1313 648 C 1348.601562 594.601562 1364.601562 537 1358.199219 484.800781 C 1347.398438 397.800781 1285.398438 335.398438 1191 316.800781 C 1164.398438 311.398438 1114.199219 311.800781 1085 317.601562 C 1054.601562 323.601562 1029.398438 332 1000.601562 346 L 976 357.800781 L 976 346.398438 C 976 290 952.800781 217.800781 919.800781 171 C 881 116.398438 829 83.601562 769.199219 76 C 751.398438 73.800781 749.398438 73.800781 728 76.199219 Z';

/**
 * Alia brand mark — the six-lobed flower glyph as an SVG (unselectable by
 * nature). Effect-free reanimated: spin while thinking/using tools,
 * opacity-pulse while streaming text, still when idle.
 */
export function AliaMark({ size = 24, state = 'idle', className, color }: AliaMarkProps) {
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
    <View
      className={className}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View style={animatedStyle}>
        <Svg width={size} height={size} viewBox={VIEWBOX}>
          <Path d={GLYPH_PATH} fill={color ?? BRAND_FILL} />
        </Svg>
      </Animated.View>
    </View>
  );
}
