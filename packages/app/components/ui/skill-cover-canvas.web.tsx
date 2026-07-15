import React, { Suspense } from "react";
import { View } from "react-native";
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web";
import type { SkillCoverCanvasProps } from "./skill-cover-palette";

// Load the skia web runtime (canvaskit.wasm) only when a skill cover actually
// mounts — the app itself renders immediately without waiting for it. Target
// the skia impl by its own basename; "./skill-cover-canvas" would resolve back
// to this .web file.
const LazySkiaCanvas = React.lazy(async () => {
  await LoadSkiaWeb({ locateFile: (file: string) => `/${file}` });
  return import("./skill-cover-canvas-skia");
});

export default function SkillCoverCanvas(props: SkillCoverCanvasProps) {
  const { width, height, cellW, cellH, grid, staticColors, isDarkColorScheme } =
    props;

  // Static first frame (plain Views) shown until canvaskit finishes loading —
  // colors match the skia canvas's frame-0 output (staticColors[i]).
  const staticGrid = (
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

  return (
    <Suspense fallback={staticGrid}>
      <LazySkiaCanvas {...props} />
    </Suspense>
  );
}
