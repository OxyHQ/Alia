import React, { Suspense, useMemo } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useColorScheme } from "@/lib/useColorScheme";
import SkillCoverStaticGrid from "./skill-cover-static";
import {
  GRID_SIZE,
  hashSeed,
  generatePalette,
  generateGrid,
  computeCellColor,
} from "./skill-cover-palette";
import type { SkillCoverCanvasProps } from "./skill-cover-palette";

/**
 * A skill's cover: a deterministic grid of colour seeded by its name, with the
 * title over the bottom.
 *
 * The cover is STATIC unless a consumer says otherwise. `animated` used to
 * default to true, and the catalogue never overrode it, so sixty results
 * became sixty Skia canvases with a clock each — 3,240 animated, shadowed
 * cells — and /skills froze Chrome (#545). Now:
 *
 * - The static grid (`skill-cover-static.tsx`) is what this module imports.
 *   Nothing here reaches skia, reanimated or a blur view, so a shelf of these
 *   costs a few hundred Views and no graphics runtime.
 * - `animated` is an explicit opt-in for ONE focused cover (the detail page).
 *   It is honoured on native only — never on web for now — and the animated
 *   module is fetched with a lazy `import()` at that moment, so a static
 *   consumer's bundle graph never contains it. Reduced motion is checked
 *   inside that module and falls back to this same grid.
 * - The animated path sits inside a local error boundary whose fallback is the
 *   static grid: navigation must never depend on WASM or GPU initialisation.
 *
 * The title scrim is a gradient, not a blur. It reads fine, and a
 * `backdrop-filter` per book was another sixty compositing layers on web.
 */

// Native-only: on web this is never fetched, so the web bundle carries no
// animated cover at all. The module is resolved lazily so the static path's
// import graph stays free of it too.
const LazyAnimatedCanvas = React.lazy(() => import("./skill-cover-animated"));

/**
 * A boundary whose whole job is to keep a cover on screen. If the animated
 * module fails to load, or the canvas throws while initialising, the person
 * sees the static grid — the same picture, minus the motion — and the page
 * around it is unaffected.
 */
class CoverErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

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
  /**
   * Opt this ONE cover into motion. Native only; ignored on web, and under
   * reduced motion. Never set it from a list.
   */
  animated?: boolean;
  title?: string;
  author?: string;
  updatedAt?: string;
}

export function SkillCover({
  seed,
  width = 110,
  color,
  animated = false,
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

  const canvasProps: SkillCoverCanvasProps = {
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
  };

  const staticGrid = <SkillCoverStaticGrid {...canvasProps} />;
  // Web is excluded HERE, before any import, so the animated module is not
  // even requested from the web bundle.
  const wantsMotion = animated && Platform.OS !== "web";

  // Scale font sizes relative to width
  const titleSize = Math.round(width * 0.17);
  const metaSize = Math.round(width * 0.082);

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={title}
      style={{
        width,
        height,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {wantsMotion ? (
        <CoverErrorBoundary fallback={staticGrid}>
          <Suspense fallback={staticGrid}>
            <LazyAnimatedCanvas {...canvasProps} />
          </Suspense>
        </CoverErrorBoundary>
      ) : (
        staticGrid
      )}

      {/* Bottom overlay: gradient scrim with title + author/date */}
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
          <LinearGradient
            colors={[
              "transparent",
              isDarkColorScheme ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.55)",
              isDarkColorScheme ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.85)",
            ]}
            locations={[0, 0.35, 1]}
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
