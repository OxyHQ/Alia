import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface PluginsIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `plugins` — the connector catalogue.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function PluginsIcon({ size = 18, color }: PluginsIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M10.312 1.855c4.965 0 8.079 3.882 7.769 8.325-.116 1.663-1.025 2.903-2.258 3.408-1.09.446-2.353.28-3.377-.559-.653.55-1.41.91-2.201.976-.918.077-1.817-.248-2.543-1.002l-.038-.04-.094-.1-.32-.337-.848-.89-.058-.068a.883.883 0 0 1 .084-1.177l.207-.2-.74-.77a.665.665 0 1 1 .958-.922l.74.769 1.793-1.725-.74-.77a.665.665 0 1 1 .957-.921l.74.768.217-.207a.88.88 0 0 1 1.25.027l1.297 1.364c.743.765 1.037 1.675.918 2.592-.076.587-.32 1.146-.677 1.652.648.499 1.373.554 1.971.31.713-.292 1.35-1.054 1.435-2.271.26-3.73-2.304-6.901-6.442-6.901-3.66 0-6.821 2.796-7.067 6.316-.275 3.938 2.511 7.261 6.753 7.262 1.481 0 2.946-.352 3.997-1.096a.666.666 0 0 1 .769 1.086c-1.345.952-3.108 1.34-4.766 1.34-5.058 0-8.406-4.023-8.08-8.685.298-4.272 4.094-7.553 8.394-7.554M7.671 11.04l.543.57.322.34.094.099.034.035c.458.473.966.637 1.47.595.525-.044 1.108-.319 1.651-.841.549-.528.854-1.097.92-1.613.065-.493-.075-1.006-.555-1.498l-.006-.006-.987-1.036z"
        fill={tint}
      />
    </Svg>
  );
}
