import React from "react";
import { View } from "react-native";
import type { SkillCoverCanvasProps } from "./skill-cover-palette";

/**
 * A skill cover's grid, drawn with plain Views.
 *
 * This is the cover the CATALOGUE shows, and on web the only cover there is.
 * It is static by construction rather than by flag: the module imports nothing
 * from `@shopify/react-native-skia` or `react-native-reanimated`, so a screen
 * that mounts sixty of these cannot initialise a graphics runtime by accident
 * (#545 — the page that did froze Chrome under 3,240 animated cells). The
 * colours are `staticColors`, the animated canvas's frame-0 output, so a cover
 * that later opts into motion starts from exactly this picture.
 *
 * Only the fields the grid needs are taken; the rest of `SkillCoverCanvasProps`
 * is accepted so the web facade can pass its props straight through.
 */
export type SkillCoverStaticGridProps = Pick<
  SkillCoverCanvasProps,
  "width" | "height" | "cellW" | "cellH" | "grid" | "staticColors" | "isDarkColorScheme"
>;

export default function SkillCoverStaticGrid({
  width,
  height,
  cellW,
  cellH,
  grid,
  staticColors,
  isDarkColorScheme,
}: SkillCoverStaticGridProps) {
  return (
    <View
      style={{
        position: "absolute",
        width,
        height,
        flexDirection: "row",
        flexWrap: "wrap",
        backgroundColor: isDarkColorScheme ? "#08080f" : "#f5f5f7",
      }}
    >
      {grid.map((cell, i) => (
        <View
          key={`${cell.row}-${cell.col}`}
          style={{
            width: cellW,
            height: cellH,
            backgroundColor: staticColors[i],
          }}
        />
      ))}
    </View>
  );
}
