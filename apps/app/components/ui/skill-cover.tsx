import React, { useMemo } from "react";
import { View, Text } from "react-native";
import {
  Canvas,
  Group,
  Rect,
  RoundedRect,
  Shadow,
} from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";
import { useClock } from "@shopify/react-native-skia";

// ─── Constants ───────────────────────────────────────────────────────────────

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
const GLOW_RADIUS_RATIO = 0.15;

// ─── Utility functions ───────────────────────────────────────────────────────

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

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return [h * 360, s * 100, l * 100];
}

type HSL = [hue: number, saturation: number, lightness: number];

function generatePalette(hash: number, color?: string): [HSL, HSL, HSL] {
  const rng = createRng(hash);

  // If a color hex is provided, derive palette from it
  if (color && color.startsWith("#") && color.length >= 7) {
    const [baseHue, baseSat] = hexToHsl(color);
    const sat = Math.max(60, baseSat);
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

function generateGrid(hash: number, rows: number, cols: number): Cell[] {
  const rng = createRng(hash + 1);
  const cells: Cell[] = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
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
  const wave = Math.sin(time * WAVE_SPEED + waveDist) * WAVE_AMPLITUDE;
  const sparkleVal =
    Math.sin(time * SPARKLE_SPEED + cell.sparklePhase);
  const sparkle =
    sparkleVal > SPARKLE_THRESHOLD
      ? ((sparkleVal - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD)) *
        SPARKLE_BOOST
      : 0;

  const finalLight = Math.min(
    90,
    Math.max(20, (l + pulse + breatheOffset + wave + sparkle) * cell.brightness),
  );
  const finalSat = Math.min(100, s + 5);

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

  const hex = (v: number) => {
    const h = v.toString(16);
    return h.length < 2 ? "0" + h : h;
  };
  return "#" + hex(r) + hex(g) + hex(b);
}

// ─── Animated cell ───────────────────────────────────────────────────────────

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

function formatShortDate(dateStr?: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export interface SkillCoverProps {
  seed: string;
  width?: number;
  color?: string;
  animated?: boolean;
  title?: string;
  author?: string;
  updatedAt?: string;
}

export function SkillCover({
  seed,
  width = 110,
  color,
  animated = true,
  title,
  author,
  updatedAt,
}: SkillCoverProps) {
  const height = width * 1.5; // 2:3 aspect ratio
  const cols = GRID_SIZE;
  const rows = Math.ceil(GRID_SIZE * 1.5); // More rows for the taller shape

  const hash = useMemo(() => hashSeed(seed), [seed]);
  const palette = useMemo(() => generatePalette(hash, color), [hash, color]);
  const grid = useMemo(() => generateGrid(hash, rows, cols), [hash, rows, cols]);

  const cellW = width / cols;
  const cellH = height / rows;
  const halfW = width / 2;
  const halfH = height / 2;

  const glowColor = useMemo(() => {
    const [h, s, l] = palette[0];
    const sl = s / 100;
    const ll = (l * 0.5) / 100;
    const a = sl * Math.min(ll, 1 - ll);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return ll - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    const r = Math.round(255 * f(0));
    const g = Math.round(255 * f(8));
    const b = Math.round(255 * f(4));
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return "#" + hex(r) + hex(g) + hex(b);
  }, [palette]);

  const staticColors = useMemo(
    () => grid.map((cell) => computeCellColor(0, cell, palette)),
    [grid, palette],
  );

  const clock = useClock();

  const scaleTransform = useDerivedValue(() => {
    if (!animated) {
      return [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }];
    }
    const t = clock.value;
    const s = 1 + Math.sin(t * SCALE_PULSE_SPEED) * SCALE_PULSE_AMOUNT;
    return [
      { translateX: halfW },
      { translateY: halfH },
      { scale: s },
      { translateX: -halfW },
      { translateY: -halfH },
    ];
  });

  // Scale font sizes relative to width
  const titleSize = Math.round(width * 0.13);
  const metaSize = Math.round(width * 0.082);

  return (
    <View
      style={{
        width,
        height,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <Canvas style={{ width, height, position: "absolute" }}>
        {/* Dark background */}
        <Rect x={0} y={0} width={width} height={height} color="#08080f" />

        {/* Scale-pulsing grid — per-cell glow (matches canvas shadowBlur) */}
        <Group transform={scaleTransform}>
          {grid.map((cell, i) =>
            animated ? (
              <AnimatedCell
                key={`${cell.row}-${cell.col}`}
                x={cell.col * cellW}
                y={cell.row * cellH}
                width={cellW}
                height={cellH}
                cell={cell}
                palette={palette}
                clock={clock}
                glowBlur={cellW * 0.45}
              />
            ) : (
              <StaticCell
                key={`${cell.row}-${cell.col}`}
                x={cell.col * cellW}
                y={cell.row * cellH}
                width={cellW}
                height={cellH}
                color={staticColors[i]}
                glowBlur={cellW * 0.45}
              />
            ),
          )}
        </Group>

        {/* Subtle border glow */}
        <RoundedRect
          x={1}
          y={1}
          width={width - 2}
          height={height - 2}
          r={3}
          style="stroke"
          strokeWidth={1.5}
          color={glowColor}
        >
          <Shadow
            dx={0}
            dy={0}
            blur={width * GLOW_RADIUS_RATIO}
            color={glowColor}
          />
        </RoundedRect>
      </Canvas>

      {/* Title at top */}
      {title && (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            padding: width * 0.07,
          }}
          pointerEvents="none"
        >
          <Text
            numberOfLines={3}
            style={{
              color: "rgba(255,255,255,0.95)",
              fontSize: titleSize,
              fontWeight: "900",
              lineHeight: titleSize * 1.15,
            }}
          >
            {title}
          </Text>
        </View>
      )}

      {/* Author + date at bottom */}
      {(author || updatedAt) && (
        <View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: width * 0.07,
          }}
          pointerEvents="none"
        >
          <Text
            numberOfLines={1}
            style={{
              color: "rgba(255,255,255,0.5)",
              fontSize: metaSize,
            }}
          >
            {author}{updatedAt ? ` · ${formatShortDate(updatedAt)}` : ""}
          </Text>
        </View>
      )}
    </View>
  );
}
