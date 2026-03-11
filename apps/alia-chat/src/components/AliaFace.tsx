import React, { useEffect, useMemo } from "react";
import { View, Text, Image, ImageSourcePropType } from "react-native";
import Svg, { Path, Ellipse } from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  cancelAnimation,
  Easing,
} from "react-native-reanimated";
import { useAliaColors } from "../theme";

// ─── Animated SVG wrappers ──────────────────────────────────────────────────

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

// ─── Types ──────────────────────────────────────────────────────────────────

export type AliaExpression =
  | "Idle A"
  | "Interesting"
  | "Top Left"
  | "Greeting"
  | "Searching A"
  | "Thinking"
  | "Error"
  | "Writing E"
  | "Searching F"
  | "Looking Down";

export interface AliaAccessory {
  layer: 'front' | 'behind';
  image: ImageSourcePropType;
}

export interface AliaFaceProps {
  expression?: AliaExpression;
  size?: number;
  showLabel?: boolean;
  /** Accessory overlays rendered on/around the face circle */
  accessories?: AliaAccessory[];
}

// ─── Expression data (numeric decomposition of SVG paths) ───────────────────
//
// leftEye:  [cx, cy, r]
// rightEye: [cx, cy, r]
// leftBrow: [sx, sy, cx, cy, ex, ey]           from  M sx sy Q cx cy ex ey
// noseBrow: [sx, sy, c1x, c1y, c2x, c2y,       from  M sx sy C c1x c1y, c2x c2y, ex ey
//            ex, ey, lx1, ly1, lx2, ly2]               L lx1 ly1 L lx2 ly2

interface ExpressionData {
  leftEye: [number, number, number];
  rightEye: [number, number, number];
  leftBrow: [number, number, number, number, number, number];
  noseBrow: [
    number, number, number, number, number, number,
    number, number, number, number, number, number,
  ];
}

const EXPRESSIONS: Record<AliaExpression, ExpressionData> = {
  "Idle A": {
    leftEye: [123, 118, 11],
    rightEye: [182, 126, 11],
    leftBrow: [91, 90, 127, 53, 154, 85],
    noseBrow: [224, 98, 195, 57, 177, 79, 160, 110, 98, 225, 149, 230],
  },
  Interesting: {
    leftEye: [127, 104, 11],
    rightEye: [191, 107, 11],
    leftBrow: [97, 91, 122, 68, 141, 76],
    noseBrow: [233, 79, 208, 54, 166, 59, 143, 104, 89, 192, 133, 212],
  },
  "Top Left": {
    leftEye: [135, 74, 11],
    rightEye: [181, 101, 11],
    leftBrow: [114, 56, 145, 28, 169, 52],
    noseBrow: [227, 104, 209, 66, 180, 68, 162, 87, 94, 174, 137, 195],
  },
  Greeting: {
    leftEye: [123, 120, 11],
    rightEye: [182, 126, 11],
    leftBrow: [91, 70, 127, 33, 154, 65],
    noseBrow: [224, 75, 195, 30, 177, 79, 160, 110, 98, 225, 149, 230],
  },
  "Searching A": {
    leftEye: [103, 98, 11],
    rightEye: [162, 106, 11],
    leftBrow: [71, 70, 107, 33, 134, 65],
    noseBrow: [204, 78, 175, 37, 157, 59, 140, 90, 78, 205, 129, 210],
  },
  Thinking: {
    leftEye: [123, 118, 11],
    rightEye: [182, 126, 11],
    leftBrow: [91, 85, 127, 48, 154, 80],
    noseBrow: [235, 85, 205, 65, 177, 79, 160, 110, 98, 225, 149, 230],
  },
  Error: {
    leftEye: [110, 240, 11],
    rightEye: [170, 250, 9],
    leftBrow: [80, 210, 110, 200, 140, 220],
    noseBrow: [250, 250, 230, 180, 203, 203, 180, 220, 120, 280, 160, 280],
  },
  "Writing E": {
    leftEye: [148, 118, 11],
    rightEye: [207, 126, 11],
    leftBrow: [116, 90, 152, 53, 179, 85],
    noseBrow: [249, 98, 220, 57, 202, 79, 185, 110, 123, 225, 174, 230],
  },
  "Searching F": {
    leftEye: [143, 98, 11],
    rightEye: [202, 106, 11],
    leftBrow: [111, 70, 147, 33, 174, 65],
    noseBrow: [244, 78, 215, 37, 197, 59, 180, 90, 118, 205, 169, 210],
  },
  "Looking Down": {
    leftEye: [106, 146, 11],
    rightEye: [168, 146, 11],
    leftBrow: [62, 107, 96, 61, 124, 84],
    noseBrow: [203, 90, 182, 65, 140, 85, 133, 130, 119, 238, 159, 222],
  },
};

const DEFAULT_EXPRESSION: AliaExpression = "Idle A";
const MORPH_CONFIG = { duration: 600, easing: Easing.bezier(0.4, 0, 0.2, 1) };

// ─── Component ──────────────────────────────────────────────────────────────

export function AliaFace({
  expression = DEFAULT_EXPRESSION,
  size = 120,
  showLabel = false,
  accessories,
}: AliaFaceProps) {
  const colors = useAliaColors();
  const strokeColor = colors.isDark ? "#ffffff" : "#000000";
  const circleBg = colors.background;
  const circleBorder = colors.border;

  const initial = EXPRESSIONS[DEFAULT_EXPRESSION];

  // ── Expression shared values (24 total) ──

  // Left eye: cx, cy, r
  const leX = useSharedValue(initial.leftEye[0]);
  const leY = useSharedValue(initial.leftEye[1]);
  const leR = useSharedValue(initial.leftEye[2]);

  // Right eye: cx, cy, r
  const reX = useSharedValue(initial.rightEye[0]);
  const reY = useSharedValue(initial.rightEye[1]);
  const reR = useSharedValue(initial.rightEye[2]);

  // Left brow: M(sx,sy) Q(cx,cy, ex,ey)
  const lb0 = useSharedValue(initial.leftBrow[0]);
  const lb1 = useSharedValue(initial.leftBrow[1]);
  const lb2 = useSharedValue(initial.leftBrow[2]);
  const lb3 = useSharedValue(initial.leftBrow[3]);
  const lb4 = useSharedValue(initial.leftBrow[4]);
  const lb5 = useSharedValue(initial.leftBrow[5]);

  // Nose+right brow: M(sx,sy) C(c1x,c1y, c2x,c2y, ex,ey) L(lx1,ly1) L(lx2,ly2)
  const nb0 = useSharedValue(initial.noseBrow[0]);
  const nb1 = useSharedValue(initial.noseBrow[1]);
  const nb2 = useSharedValue(initial.noseBrow[2]);
  const nb3 = useSharedValue(initial.noseBrow[3]);
  const nb4 = useSharedValue(initial.noseBrow[4]);
  const nb5 = useSharedValue(initial.noseBrow[5]);
  const nb6 = useSharedValue(initial.noseBrow[6]);
  const nb7 = useSharedValue(initial.noseBrow[7]);
  const nb8 = useSharedValue(initial.noseBrow[8]);
  const nb9 = useSharedValue(initial.noseBrow[9]);
  const nb10 = useSharedValue(initial.noseBrow[10]);
  const nb11 = useSharedValue(initial.noseBrow[11]);

  // ── Animation shared values ──

  const breatheY = useSharedValue(0);
  const blinkScale = useSharedValue(1);
  const tw0 = useSharedValue(0); // thinking wave: left brow
  const tw1 = useSharedValue(0); // thinking wave: left eye
  const tw2 = useSharedValue(0); // thinking wave: right eye
  const tw3 = useSharedValue(0); // thinking wave: nose brow
  const lookX = useSharedValue(0); // look-around: eye X offset

  // ── Breathe (always on) ──

  useEffect(() => {
    breatheY.value = withRepeat(
      withSequence(
        withTiming(-4, { duration: 2500, easing: Easing.inOut(Easing.ease) }),
        withTiming(4, { duration: 2500, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );
    return () => cancelAnimation(breatheY);
  }, []);

  // ── Blink (always on) ──

  useEffect(() => {
    blinkScale.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3500, easing: Easing.linear }),
        withTiming(0.1, { duration: 80, easing: Easing.linear }),
        withTiming(1, { duration: 120, easing: Easing.linear }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(blinkScale);
  }, []);

  // ── Expression morph ──

  useEffect(() => {
    const target = EXPRESSIONS[expression] ?? EXPRESSIONS[DEFAULT_EXPRESSION];

    leX.value = withTiming(target.leftEye[0], MORPH_CONFIG);
    leY.value = withTiming(target.leftEye[1], MORPH_CONFIG);
    leR.value = withTiming(target.leftEye[2], MORPH_CONFIG);

    reX.value = withTiming(target.rightEye[0], MORPH_CONFIG);
    reY.value = withTiming(target.rightEye[1], MORPH_CONFIG);
    reR.value = withTiming(target.rightEye[2], MORPH_CONFIG);

    lb0.value = withTiming(target.leftBrow[0], MORPH_CONFIG);
    lb1.value = withTiming(target.leftBrow[1], MORPH_CONFIG);
    lb2.value = withTiming(target.leftBrow[2], MORPH_CONFIG);
    lb3.value = withTiming(target.leftBrow[3], MORPH_CONFIG);
    lb4.value = withTiming(target.leftBrow[4], MORPH_CONFIG);
    lb5.value = withTiming(target.leftBrow[5], MORPH_CONFIG);

    nb0.value = withTiming(target.noseBrow[0], MORPH_CONFIG);
    nb1.value = withTiming(target.noseBrow[1], MORPH_CONFIG);
    nb2.value = withTiming(target.noseBrow[2], MORPH_CONFIG);
    nb3.value = withTiming(target.noseBrow[3], MORPH_CONFIG);
    nb4.value = withTiming(target.noseBrow[4], MORPH_CONFIG);
    nb5.value = withTiming(target.noseBrow[5], MORPH_CONFIG);
    nb6.value = withTiming(target.noseBrow[6], MORPH_CONFIG);
    nb7.value = withTiming(target.noseBrow[7], MORPH_CONFIG);
    nb8.value = withTiming(target.noseBrow[8], MORPH_CONFIG);
    nb9.value = withTiming(target.noseBrow[9], MORPH_CONFIG);
    nb10.value = withTiming(target.noseBrow[10], MORPH_CONFIG);
    nb11.value = withTiming(target.noseBrow[11], MORPH_CONFIG);
  }, [expression]);

  // ── Thinking wave (conditional) ──

  useEffect(() => {
    const waves = [tw0, tw1, tw2, tw3];
    if (expression === "Thinking") {
      waves.forEach((sv, i) => {
        sv.value = withDelay(
          i * 200,
          withRepeat(
            withSequence(
              withTiming(-3, {
                duration: 1250,
                easing: Easing.inOut(Easing.ease),
              }),
              withTiming(3, {
                duration: 1250,
                easing: Easing.inOut(Easing.ease),
              }),
            ),
            -1,
            true,
          ),
        );
      });
    } else {
      waves.forEach((sv) => {
        cancelAnimation(sv);
        sv.value = withTiming(0, { duration: 300 });
      });
    }
    return () => waves.forEach((sv) => cancelAnimation(sv));
  }, [expression]);

  // ── Look around (conditional) ──

  useEffect(() => {
    if (expression === "Searching F") {
      lookX.value = withRepeat(
        withSequence(
          withTiming(-6, {
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
          }),
          withTiming(8, {
            duration: 2000,
            easing: Easing.inOut(Easing.ease),
          }),
          withTiming(0, {
            duration: 500,
            easing: Easing.inOut(Easing.ease),
          }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(lookX);
      lookX.value = withTiming(0, { duration: 300 });
    }
    return () => cancelAnimation(lookX);
  }, [expression]);

  // ── Animated props ──

  const leftBrowProps = useAnimatedProps(() => ({
    d: `M ${lb0.value} ${lb1.value + tw0.value} Q ${lb2.value} ${lb3.value + tw0.value} ${lb4.value} ${lb5.value + tw0.value}`,
  }));

  const noseBrowProps = useAnimatedProps(() => ({
    d: `M ${nb0.value} ${nb1.value + tw3.value} C ${nb2.value} ${nb3.value + tw3.value}, ${nb4.value} ${nb5.value + tw3.value}, ${nb6.value} ${nb7.value + tw3.value} L ${nb8.value} ${nb9.value + tw3.value} L ${nb10.value} ${nb11.value + tw3.value}`,
  }));

  const leftEyeProps = useAnimatedProps(() => ({
    cx: leX.value + lookX.value,
    cy: leY.value + tw1.value,
    rx: leR.value,
    ry: leR.value * blinkScale.value,
  }));

  const rightEyeProps = useAnimatedProps(() => ({
    cx: reX.value + lookX.value,
    cy: reY.value + tw2.value,
    rx: reR.value,
    ry: reR.value * blinkScale.value,
  }));

  // ── Breathe style on wrapper ──

  const breatheStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: breatheY.value }],
  }));

  // ── Accessories ──

  const { behind, front } = useMemo(() => {
    if (!accessories?.length) return { behind: [] as AliaAccessory[], front: [] as AliaAccessory[] };
    const b: AliaAccessory[] = [];
    const f: AliaAccessory[] = [];
    for (const acc of accessories) {
      if (acc.layer === 'behind') b.push(acc);
      else f.push(acc);
    }
    return { behind: b, front: f };
  }, [accessories]);

  const accessoryStyle = useMemo(
    () => ({ position: 'absolute' as const, width: size, height: size, top: 0, left: 0 }),
    [size],
  );

  // ── Render ──

  return (
    <View style={{ alignItems: "center" }}>
      <View style={{ width: size, height: size, overflow: 'visible' as const }}>
        {/* Behind-layer accessories (e.g. headphones) */}
        {behind.map((acc, i) => (
          <Image key={`behind-${i}`} source={acc.image} style={accessoryStyle} />
        ))}

        {/* Face circle */}
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: circleBg,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: circleBorder,
          }}
        >
          <Animated.View style={breatheStyle}>
            <Svg
              width={size * 0.95}
              height={size * 0.95}
              viewBox="35 35 250 250"
            >
              {/* Left brow */}
              <AnimatedPath
                animatedProps={leftBrowProps}
                stroke={strokeColor}
                strokeWidth={15}
                strokeLinecap="round"
                fill="none"
              />

              {/* Left eye */}
              <AnimatedEllipse
                animatedProps={leftEyeProps}
                fill={strokeColor}
              />

              {/* Right eye */}
              <AnimatedEllipse
                animatedProps={rightEyeProps}
                fill={strokeColor}
              />

              {/* Nose + right brow */}
              <AnimatedPath
                animatedProps={noseBrowProps}
                stroke={strokeColor}
                strokeWidth={15}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </Svg>
          </Animated.View>
        </View>

        {/* Front-layer accessories (e.g. hat, glasses, tie) */}
        {front.map((acc, i) => (
          <Image key={`front-${i}`} source={acc.image} style={accessoryStyle} />
        ))}
      </View>

      {showLabel && (
        <Text style={{ fontSize: 10, color: colors.mutedForeground, marginTop: 8, textTransform: 'uppercase', letterSpacing: 3, fontWeight: '700' }}>
          {expression}
        </Text>
      )}
    </View>
  );
}
