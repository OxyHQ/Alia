import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { useColorScheme } from "@/lib/useColorScheme";
import SkillCoverCanvas from "./skill-cover-canvas";
import {
  GRID_SIZE,
  hashSeed,
  generatePalette,
  generateGrid,
  computeCellColor,
} from "./skill-cover-palette";

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
  const { isDarkColorScheme } = useColorScheme();
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
  const lightMode = !isDarkColorScheme;

  const glowColor = useMemo(() => {
    const [h, s, l] = palette[0];
    const sl = s / 100;
    const ll = (lightMode ? l * 0.8 : l * 0.5) / 100;
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
  }, [palette, lightMode]);

  const staticColors = useMemo(
    () => grid.map((cell) => computeCellColor(0, cell, palette, lightMode)),
    [grid, palette, lightMode],
  );

  // Scale font sizes relative to width
  const titleSize = Math.round(width * 0.17);
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
      <SkillCoverCanvas
        width={width}
        height={height}
        cellW={cellW}
        cellH={cellH}
        halfW={halfW}
        halfH={halfH}
        grid={grid}
        palette={palette}
        staticColors={staticColors}
        glowColor={glowColor}
        animated={animated}
        lightMode={lightMode}
        isDarkColorScheme={isDarkColorScheme}
      />

      {/* Bottom overlay: blurred gradient with title + author/date */}
      {(title || author || updatedAt) && (
        <View
          style={{
            position: "absolute",
            bottom: 2,
            left: 2,
            right: 2,
            height: height - 3 * (height / rows) - 2,
            borderBottomLeftRadius: 2,
            borderBottomRightRadius: 2,
            overflow: "hidden",
          }}
          pointerEvents="none"
        >
          <BlurView
            intensity={30}
            tint={isDarkColorScheme ? "dark" : "light"}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={[
              "transparent",
              isDarkColorScheme
                ? "rgba(0,0,0,0.7)"
                : "rgba(255,255,255,0.7)",
            ]}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={{
              flex: 1,
              justifyContent: "space-between",
              padding: width * 0.07,
            }}
          >
            {title ? (
              <Text
                numberOfLines={3}
                style={{
                  color: isDarkColorScheme ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.9)",
                  fontSize: titleSize,
                  fontWeight: "900",
                  lineHeight: titleSize * 1.15,
                }}
              >
                {title}
              </Text>
            ) : <View />}
            {(author || updatedAt) && (
              <View>
                {author && (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: isDarkColorScheme ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)",
                      fontSize: metaSize,
                    }}
                  >
                    {author}
                  </Text>
                )}
                {updatedAt && (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: isDarkColorScheme ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.35)",
                      fontSize: metaSize,
                    }}
                  >
                    {formatShortDate(updatedAt)}
                  </Text>
                )}
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
