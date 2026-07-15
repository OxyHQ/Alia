import React from "react";
import {
  Canvas,
  Group,
  Rect,
  RoundedRect,
  Shadow,
  useClock,
} from "@shopify/react-native-skia";
import { useDerivedValue } from "react-native-reanimated";
import { computeCellColor } from "./skill-cover-palette";
import type { Cell, HSL, SkillCoverCanvasProps } from "./skill-cover-palette";

const SCALE_PULSE_SPEED = 0.0008;
const SCALE_PULSE_AMOUNT = 0.03;

const GLOW_RADIUS_RATIO = 0.15;

function AnimatedCell({
  x,
  y,
  width,
  height,
  cell,
  palette,
  clock,
  glowBlur,
  lightMode,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  cell: Cell;
  palette: [HSL, HSL, HSL];
  clock: { value: number };
  glowBlur: number;
  lightMode: boolean;
}) {
  const color = useDerivedValue(() => {
    return computeCellColor(clock.value, cell, palette, lightMode);
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

export default function SkillCoverCanvas({
  width,
  height,
  cellW,
  cellH,
  halfW,
  halfH,
  grid,
  palette,
  staticColors,
  glowColor,
  animated,
  lightMode,
  isDarkColorScheme,
}: SkillCoverCanvasProps) {
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

  return (
    <Canvas style={{ width, height, position: "absolute" }}>
      {/* Background */}
      <Rect x={0} y={0} width={width} height={height} color={isDarkColorScheme ? "#08080f" : "#f5f5f7"} />

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
              lightMode={lightMode}
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
  );
}
