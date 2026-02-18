import React, { useMemo } from "react";
import { Platform, View } from "react-native";
import {
  Canvas,
  Group,
  Rect,
  Circle,
  Shadow,
  Image as SkiaImage,
  useImage,
} from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";
import { useClock } from "@shopify/react-native-skia";

// Default avatar: on web, require() returns a module ID that Skia can't resolve,
// so we use a direct path to the public/ copy instead.
// See: https://github.com/Shopify/react-native-skia/issues/2218
const DEFAULT_AVATAR_SOURCE =
  Platform.OS === "web"
    ? "/agent-avatar-reference.png"
    : require("@/assets/images/agent-avatar-reference.png");

// ─── Constants (matched from original HTML canvas component) ─────────────────

const GRID_SIZE = 6;

const PULSE_SPEED = 0.002;
const PULSE_AMPLITUDE = 22;

const BREATHE_SPEED = 0.001;
const BREATHE_AMPLITUDE = 10;

const WAVE_SPEED = 0.0015;
const WAVE_AMPLITUDE = 15;
const WAVE_LENGTH = 3;

const SPARKLE_SPEED = 0.004;
const SPARKLE_THRESHOLD = 0.92;
const SPARKLE_BOOST = 25;

const SCALE_PULSE_SPEED = 0.0008;
const SCALE_PULSE_AMOUNT = 0.03;

const HUE_SPREAD = 45;
const GLOW_RADIUS_RATIO = 0.25;

// ─── Pure utility functions ──────────────────────────────────────────────────

function hashSeed(str: string): number {
  let hash = 0;
  for (const char of str) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function createRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hslToHex(h: number, s: number, l: number): string {
  "worklet";
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

type HSL = [hue: number, saturation: number, lightness: number];

function generatePalette(hash: number): [HSL, HSL, HSL] {
  const rng = createRng(hash);
  const baseHue = rng() * 360;
  const sat = 75 + rng() * 20;

  return [
    [baseHue, sat, 55 + rng() * 10],
    [
      (baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2 + 360) % 360,
      sat - 5 + rng() * 10,
      40 + rng() * 15,
    ],
    [
      (baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2 + 360) % 360,
      sat - 10 + rng() * 15,
      60 + rng() * 15,
    ],
  ];
}

interface Cell {
  row: number;
  col: number;
  colorIndex: number;
  phase: number;
  brightness: number;
  sparklePhase: number;
}

function generateGrid(hash: number): Cell[] {
  const rng = createRng(hash + 1);
  const cells: Cell[] = [];

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      cells.push({
        row: y,
        col: x,
        colorIndex: Math.floor(rng() * 3),
        phase: rng() * Math.PI * 2,
        brightness: 0.3 + rng() * 0.7,
        sparklePhase: rng() * Math.PI * 2,
      });
    }
  }

  return cells;
}

function computeCellColor(
  time: number,
  cell: Cell,
  palette: [HSL, HSL, HSL],
): string {
  "worklet";
  const [h, s, l] = palette[cell.colorIndex];

  const pulse =
    Math.sin(time * PULSE_SPEED + cell.phase) * PULSE_AMPLITUDE;

  const breatheOffset =
    Math.sin(time * BREATHE_SPEED) * BREATHE_AMPLITUDE;

  const waveDist = (cell.col + cell.row) / WAVE_LENGTH;
  const wave =
    Math.sin(time * WAVE_SPEED + waveDist) * WAVE_AMPLITUDE;

  const sparkleVal =
    Math.sin(time * SPARKLE_SPEED + cell.sparklePhase);
  const sparkle =
    sparkleVal > SPARKLE_THRESHOLD
      ? ((sparkleVal - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD)) *
        SPARKLE_BOOST
      : 0;

  const finalLight = Math.min(
    90,
    Math.max(
      20,
      (l + pulse + breatheOffset + wave + sparkle) * cell.brightness,
    ),
  );
  const finalSat = Math.min(100, s + 5);

  // Inline HSL→hex conversion (worklet-compatible, no toString)
  const sl = finalSat / 100;
  const ll = finalLight / 100;
  const a = sl * Math.min(ll, 1 - ll);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return ll - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));

  // Pack into Skia-compatible color int (ARGB)
  // Skia accepts Float32Array [r,g,b,a] or string — use string for simplicity
  const hex = (v: number) => {
    const h = v.toString(16);
    return h.length < 2 ? "0" + h : h;
  };
  return "#" + hex(r) + hex(g) + hex(b);
}

// ─── Animated cell sub-component (hooks can't go in .map()) ─────────────────

function AnimatedCell({
  x,
  y,
  width,
  height,
  cell,
  palette,
  clock,
  glowBlur,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  cell: Cell;
  palette: [HSL, HSL, HSL];
  clock: { value: number };
  glowBlur: number;
}) {
  const color = useDerivedValue(() => {
    return computeCellColor(clock.value, cell, palette);
  });

  return (
    <Rect x={x} y={y} width={width} height={height} color={color}>
      <Shadow dx={0} dy={0} blur={glowBlur} color={color} />
    </Rect>
  );
}

function StaticCell({
  x,
  y,
  width,
  height,
  color,
  glowBlur,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  glowBlur: number;
}) {
  return (
    <Rect x={x} y={y} width={width} height={height} color={color}>
      <Shadow dx={0} dy={0} blur={glowBlur} color={color} />
    </Rect>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export interface AgentPlaceholderProps {
  seed: string;
  size?: number;
  animated?: boolean;
  avatarUrl?: string | null;
}

export function AgentPlaceholder({
  seed,
  size = 64,
  animated = true,
  avatarUrl,
}: AgentPlaceholderProps) {
  const hash = useMemo(() => hashSeed(seed), [seed]);
  const palette = useMemo(() => generatePalette(hash), [hash]);
  const grid = useMemo(() => generateGrid(hash), [hash]);

  const cellSize = size / GRID_SIZE;
  const half = size / 2;

  // SVG path string for circular clip — avoids imperative Skia.Path.Make()
  // which requires CanvasKit to be loaded (not guaranteed on web at render time)
  const clipPath = useMemo(
    () =>
      `M 0 ${half} A ${half} ${half} 0 1 1 ${size} ${half} A ${half} ${half} 0 1 1 0 ${half} Z`,
    [half, size],
  );

  // Glow color from primary palette
  const glowColor = useMemo(
    () => hslToHex(palette[0][0], palette[0][1], palette[0][2]),
    [palette],
  );
  const glowColorFaint = useMemo(
    () => hslToHex(palette[0][0], palette[0][1], palette[0][2] * 0.5),
    [palette],
  );

  // Static colors for non-animated mode
  const staticColors = useMemo(
    () => grid.map((cell) => computeCellColor(0, cell, palette)),
    [grid, palette],
  );

  const avatarSource = avatarUrl || DEFAULT_AVATAR_SOURCE;
  const avatarImage = useImage(avatarSource);

  const clock = useClock();

  // Animated scale-pulse transform
  const scaleTransform = useDerivedValue(() => {
    if (!animated) {
      return [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }];
    }
    const t = clock.value;
    const s = 1 + Math.sin(t * SCALE_PULSE_SPEED) * SCALE_PULSE_AMOUNT;
    return [
      { translateX: half },
      { translateY: half },
      { scale: s },
      { translateX: -half },
      { translateY: -half },
    ];
  });

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: half,
        overflow: "hidden",
      }}
    >
    <Canvas style={{ width: size, height: size }}>
      <Group clip={clipPath}>
        {/* Dark background */}
        <Rect x={0} y={0} width={size} height={size} color="#08080f" />

        {/* Scale-pulsing grid — per-cell glow */}
        <Group transform={scaleTransform}>
          {grid.map((cell, i) =>
            animated ? (
              <AnimatedCell
                key={`${cell.row}-${cell.col}`}
                x={cell.col * cellSize}
                y={cell.row * cellSize}
                width={cellSize}
                height={cellSize}
                cell={cell}
                palette={palette}
                clock={clock}
                glowBlur={cellSize * 0.45}
              />
            ) : (
              <StaticCell
                key={`${cell.row}-${cell.col}`}
                x={cell.col * cellSize}
                y={cell.row * cellSize}
                width={cellSize}
                height={cellSize}
                color={staticColors[i]}
                glowBlur={cellSize * 0.45}
              />
            ),
          )}
        </Group>

        {/* Avatar overlay — transparent PNG, figure on top of the grid */}
        {avatarImage && (
          <SkiaImage
            image={avatarImage}
            x={0}
            y={0}
            width={size}
            height={size}
            fit="cover"
          />
        )}

        {/* Outer glow ring */}
        <Group blendMode="screen">
          <Circle
            cx={half}
            cy={half}
            r={half - 1}
            style="stroke"
            strokeWidth={2}
            color={glowColorFaint}
          >
            <Shadow
              dx={0}
              dy={0}
              blur={size * GLOW_RADIUS_RATIO}
              color={glowColor}
            />
          </Circle>
        </Group>
      </Group>
    </Canvas>
    </View>
  );
}
