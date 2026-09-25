import type { BloomIconComponent } from "@oxy.so/bloom/icons";
import Svg, { Circle, Path } from "react-native-svg";
import { useColorScheme } from "@/shared/platform/useColorScheme";

/**
 * `clock` — Automations — scheduled triggers, in the sidebar and the agent editor.
 *
 * Bloom's icon contract (`width`, `height`, `fill`), so it sits in any list of
 * Bloom icons; the fill defaults to the theme's muted foreground.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `src/shared/ui/__tests__/generated-icons.test.ts`.
 */
export const ClockIcon: BloomIconComponent = ({ width = 18, height = width, fill }) => {
  const { colors } = useColorScheme();
  const tint = fill ?? colors.mutedForeground;
  return (
    <Svg width={width} height={height} viewBox="0 0 20 20" fill="none">
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
};
