import Svg, { Circle, Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface ClockIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `clock` — Automations — scheduled triggers, in the sidebar and the agent editor.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function ClockIcon({ size = 18, color }: ClockIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle
        cx={10}
        cy={10}
        r={7.5}
        fill="none"
        stroke={tint}
        strokeWidth={1.33}
      />
      <Path
        d="M10 5.834v3.994c0 .11-.044.216-.122.294l-1.961 1.962"
        fill="none"
        stroke={tint}
        strokeWidth={1.33}
        strokeLinecap="round"
      />
    </Svg>
  );
}
