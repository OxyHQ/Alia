import { useEffect, useState } from 'react';
import { Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { AgentState } from '@alia.onl/sdk/voice';

/**
 * Cross-platform blur. React Native 0.86 types `filter` on `ViewStyle`, but the
 * two platforms take different shapes: a CSS string on web, the filter-function
 * array on native.
 */
function blurStyle(radius: number): ViewStyle {
  return Platform.OS === 'web'
    ? { filter: `blur(${radius}px)` }
    : { filter: [{ blur: radius }] };
}

/** The blobs enter over 2.4s. */
const ENTER_DURATION = 2400;
const ENTER_EASE = Easing.bezier(0.22, 0.7, 0.24, 1);
/** The enter keyframes reach full opacity at 60% of the run. */
const ENTER_FADE_DURATION = ENTER_DURATION * 0.6;
/** Pointer parallax settle. */
const PARALLAX_DURATION = 550;
const PARALLAX_EASE = Easing.bezier(0.2, 0.7, 0.2, 1);
/** Per-blob opacity — dark mode needs less to read the same. */
const BLOB_OPACITY_LIGHT = 0.55;
const BLOB_OPACITY_DARK = 0.4;
/** One blur over the whole field, not per blob. */
const FIELD_BLUR = 70;
/** How long the intensity target takes to ramp, matching the voice overlay. */
const INTENSITY_RAMP = 500;
/** Exit: the field sinks and dims while whatever is behind it rises. */
const EXIT_OPACITY_DURATION = 800;
const EXIT_TRANSFORM_DURATION = 900;
const EXIT_EASE = Easing.bezier(0.2, 0.7, 0.2, 1);

/** One keyframe stop of a float loop: [translateX in vw, translateY in vh, scale]. */
type FloatStop = readonly [number, number, number];

type FlourishConfig = {
  /** Diameter, in vmax. */
  w: number;
  /** Where the blob enters from, in vw / vh. */
  sx: number;
  sy: number;
  /** Where it comes to rest, in vw / vh. */
  rx: number;
  ry: number;
  /** Entrance delay, in ms. */
  delay: number;
  /** Parallax reach at the pointer's extremes, in px. */
  px: number;
  py: number;
  /** Float loop period, in ms. */
  fdur: number;
  /** How strongly this blob answers the live amplitude. */
  amp: number;
  /** The float keyframes at 33% and 66%; both ends of the loop are the origin. */
  float: readonly [FloatStop, FloatStop];
};

/**
 * The three blobs are centred and then pushed down by `ry` (48–57vh), which is
 * what lays them along the bottom edge.
 */
const FLOURISHES: readonly FlourishConfig[] = [
  {
    w: 51,
    sx: -52,
    sy: 70,
    rx: -22,
    ry: 50,
    delay: 850,
    px: 120,
    py: 72,
    fdur: 8000,
    amp: 1,
    float: [
      [4, 2, 1.08],
      [2, -3, 0.96],
    ],
  },
  {
    w: 47,
    sx: 52,
    sy: 72,
    rx: 20,
    ry: 48,
    delay: 1030,
    px: -144,
    py: 88,
    fdur: 11000,
    amp: 1.2,
    float: [
      [-4, 3, 0.94],
      [-2, -2, 1.06],
    ],
  },
  {
    w: 49,
    sx: 12,
    sy: 80,
    rx: -2,
    ry: 57,
    delay: 1190,
    px: 104,
    py: -76,
    fdur: 9500,
    amp: 0.9,
    float: [
      [-3, -3, 1.06],
      [2, 2, 0.95],
    ],
  },
];

/**
 * One hue per blob, per agent state. Idle and listening carry the field's own
 * triad; thinking and speaking keep the amber and indigo the voice visualiser
 * already established, so a call still reads as a call.
 *
 * These are literal hex values rather than theme tokens because the palette IS
 * the effect — a single themed hue collapses into a flat wash.
 */
const PALETTES: Record<AgentState, readonly [string, string, string]> = {
  idle: ['#8b5ae0', '#b8c24a', '#f26a21'],
  listening: ['#8b5ae0', '#b8c24a', '#f26a21'],
  thinking: ['#92400e', '#eab308', '#fbbf24'],
  speaking: ['#1e2870', '#6366f1', '#9333ea'],
};

/** The warm ellipse low in the frame that keeps the bottom edge from going cold. */
const REST_COLOR = '#c7a377';
const REST_OPACITY_LIGHT = 0.122;
const REST_OPACITY_DARK = 0.078;

/** Smoothstep, so each float segment eases in and out the way CSS does. */
function smooth(t: number) {
  'worklet';
  return t * t * (3 - 2 * t);
}

/**
 * One ambient blob, in three nested layers: an outer box that enters and comes
 * to rest, a parallax layer that answers the pointer, and an inner circle that
 * carries the endless float and the live amplitude. Keeping them nested means
 * no transform has to know about the others.
 */
function Flourish({
  config,
  index,
  color,
  vw,
  vh,
  vmax,
  fieldWidth,
  fieldHeight,
  blobOpacity,
  blend,
  entrance,
  waveAmplitude,
  pointerX,
  pointerY,
}: {
  config: FlourishConfig;
  index: number;
  color: string;
  vw: number;
  vh: number;
  vmax: number;
  fieldWidth: number;
  fieldHeight: number;
  blobOpacity: number;
  blend: 'multiply' | 'screen';
  entrance: boolean;
  waveAmplitude: SharedValue<number>;
  pointerX: SharedValue<number>;
  pointerY: SharedValue<number>;
}) {
  // Without an entrance the blob is simply already at rest.
  const enter = useSharedValue(entrance ? 0 : 1);
  const fade = useSharedValue(entrance ? 0 : 1);
  const phase = useSharedValue(0);

  // Starting an animation on mount is imperative by nature: there is no
  // derived-state or event-handler form of "run once, then loop forever".
  useEffect(() => {
    if (entrance) {
      enter.value = withDelay(
        config.delay,
        withTiming(1, { duration: ENTER_DURATION, easing: ENTER_EASE }),
      );
      fade.value = withDelay(
        config.delay,
        withTiming(1, { duration: ENTER_FADE_DURATION, easing: ENTER_EASE }),
      );
    }
    phase.value = withDelay(
      entrance ? config.delay + ENTER_DURATION : 0,
      withRepeat(withTiming(1, { duration: config.fdur, easing: Easing.linear }), -1, false),
    );
  }, [enter, fade, phase, entrance, config.delay, config.fdur]);

  const size = config.w * vmax;

  const enterStyle = useAnimatedStyle(() => {
    const t = enter.value;
    const amp = waveAmplitude.value;
    return {
      // Live speech brightens the field on top of its resting opacity.
      opacity: Math.min(1, fade.value * blobOpacity * (1 + amp * 0.5)),
      transform: [
        { translateX: (config.sx + (config.rx - config.sx) * t) * vw },
        { translateY: (config.sy + (config.ry - config.sy) * t) * vh },
        { scale: 0.55 + 0.45 * t },
      ],
    };
  });

  const parallaxStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: pointerX.value * config.px },
      { translateY: pointerY.value * config.py },
    ],
  }));

  const floatStyle = useAnimatedStyle(() => {
    const [a, b] = config.float;
    const p = phase.value;
    // Four stops — origin, a, b, origin — each segment eased like ease-in-out.
    let from: FloatStop = [0, 0, 1];
    let to: FloatStop = a;
    let local = p * 3;
    if (p >= 2 / 3) {
      from = b;
      to = [0, 0, 1];
      local = (p - 2 / 3) * 3;
    } else if (p >= 1 / 3) {
      from = a;
      to = b;
      local = (p - 1 / 3) * 3;
    }
    const e = smooth(local);
    // The swell is the ONLY thing here that answers the audio, so it is the
    // only thing that may move at speech rate. A second oscillator on top used
    // to add a 900ms beat of its own: with the level canned, that beat was most
    // of the motion a listener saw, and it beat against real speech once the
    // level stopped being invented.
    const ampScale = 1 + waveAmplitude.value * 0.3 * config.amp;
    return {
      transform: [
        { translateX: (from[0] + (to[0] - from[0]) * e) * vw },
        { translateY: (from[1] + (to[1] - from[1]) * e) * vh },
        { scale: (from[2] + (to[2] - from[2]) * e) * ampScale },
      ],
    };
  });

  const gradientId = `ambient-flourish-${index}`;

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: fieldWidth / 2 - size / 2,
          top: fieldHeight / 2 - size / 2,
          width: size,
          height: size,
        },
        enterStyle,
      ]}
    >
      <Animated.View style={[{ width: '100%', height: '100%' }, parallaxStyle]}>
        <Animated.View
          // Blending is what stops three overlapping blobs reading as grey mud.
          style={[{ width: '100%', height: '100%', mixBlendMode: blend }, floatStyle]}
        >
          <Svg width={size} height={size}>
            <Defs>
              {/* An off-centre origin, fading to nothing well inside the circle. */}
              <RadialGradient id={gradientId} cx="35%" cy="35%" r="64%">
                <Stop offset="0%" stopColor={color} stopOpacity={1} />
                <Stop offset="100%" stopColor={color} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradientId})`} />
          </Svg>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

export interface AmbientFieldProps {
  /**
   * Combined amplitude from `useAmbientWave` — swells and brightens the blobs.
   * Omit where there is no audio (the intro) and the field simply rests.
   */
  waveAmplitude?: SharedValue<number>;
  /** Drives the palette. Defaults to the resting triad. */
  agentState?: AgentState;
  /** Overall opacity target; ramps over 500ms when it changes. */
  intensity?: number;
  isDarkMode?: boolean;
  /** Play the staggered 2.4s entrance. Off by default — only the intro wants it. */
  entrance?: boolean;
  /** Pointer parallax, normalised to -1..1. Omit for no parallax. */
  pointerX?: SharedValue<number>;
  /** @see pointerX */
  pointerY?: SharedValue<number>;
  /** Sink and dim the field while whatever sits behind it rises into view. */
  exiting?: boolean;
}

/**
 * The ambient background shared by the welcome intro and the chat: three
 * blurred, drifting colour fields over a warm floor glow.
 *
 * It fills its parent, so the caller decides where it sits and what it sits
 * behind. Every animation is driven through shared values and
 * `useAnimatedReaction` rather than mapper-started styles, because
 * mapper-started animations do not tick on reanimated-web.
 */
export function AmbientField({
  waveAmplitude,
  agentState = 'idle',
  intensity = 1,
  isDarkMode = false,
  entrance = false,
  pointerX,
  pointerY,
  exiting = false,
}: AmbientFieldProps) {
  const [field, setField] = useState({ width: 0, height: 0 });

  // Fallbacks so the hook count never depends on which optional shared values
  // the caller passed.
  const silence = useSharedValue(0);
  const idlePointerX = useSharedValue(0);
  const idlePointerY = useSharedValue(0);
  const amplitude = waveAmplitude ?? silence;
  const px = pointerX ?? idlePointerX;
  const py = pointerY ?? idlePointerY;

  const intensityRamp = useSharedValue(intensity);
  useAnimatedReaction(
    () => intensity,
    (target, previous) => {
      if (target === previous) return;
      intensityRamp.value = withTiming(target, { duration: INTENSITY_RAMP });
    },
    [intensity],
  );

  const exitOpacity = useSharedValue(0);
  const exitTransform = useSharedValue(0);
  useAnimatedReaction(
    () => exiting,
    (target, previous) => {
      if (target === previous) return;
      const to = target ? 1 : 0;
      exitOpacity.value = withTiming(to, {
        duration: EXIT_OPACITY_DURATION,
        easing: EXIT_EASE,
      });
      exitTransform.value = withTiming(to, {
        duration: EXIT_TRANSFORM_DURATION,
        easing: EXIT_EASE,
      });
    },
    [exiting],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setField({ width, height });
  };

  const vw = field.width / 100;
  const vh = field.height / 100;
  const vmax = Math.max(field.width, field.height) / 100;

  const fieldStyle = useAnimatedStyle(() => ({
    // On the way out the field keeps 45% of its opacity, sinking as it goes.
    opacity: intensityRamp.value * (1 - exitOpacity.value * 0.55),
    transform: [
      { translateY: exitTransform.value * 12 * vh },
      { scale: 1 + exitTransform.value * 0.1 },
    ],
  }));

  const restStyle = useAnimatedStyle(() => ({
    opacity: intensityRamp.value * (1 - exitOpacity.value * 0.5),
  }));

  const palette = PALETTES[agentState];

  return (
    <View
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
      pointerEvents="none"
      onLayout={handleLayout}
    >
      {field.width > 0 ? (
        <>
          <Animated.View style={[{ position: 'absolute', inset: 0 }, restStyle]}>
            <Svg width={field.width} height={field.height}>
              <Defs>
                <RadialGradient id="ambient-rest" cx="50%" cy="92%" rx="57%" ry="37%">
                  <Stop
                    offset="0%"
                    stopColor={REST_COLOR}
                    stopOpacity={isDarkMode ? REST_OPACITY_DARK : REST_OPACITY_LIGHT}
                  />
                  <Stop offset="70%" stopColor={REST_COLOR} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Rect
                x={0}
                y={0}
                width={field.width}
                height={field.height}
                fill="url(#ambient-rest)"
              />
            </Svg>
          </Animated.View>

          <Animated.View
            style={[{ position: 'absolute', inset: 0 }, blurStyle(FIELD_BLUR), fieldStyle]}
          >
            {FLOURISHES.map((config, index) => (
              <Flourish
                key={config.w}
                config={config}
                index={index}
                color={palette[index]}
                vw={vw}
                vh={vh}
                vmax={vmax}
                fieldWidth={field.width}
                fieldHeight={field.height}
                blobOpacity={isDarkMode ? BLOB_OPACITY_DARK : BLOB_OPACITY_LIGHT}
                blend={isDarkMode ? 'screen' : 'multiply'}
                entrance={entrance}
                waveAmplitude={amplitude}
                pointerX={px}
                pointerY={py}
              />
            ))}
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

export { PARALLAX_DURATION, PARALLAX_EASE };
