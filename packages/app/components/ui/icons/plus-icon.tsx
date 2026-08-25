import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface PlusIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `plus` — New Chat, and the add action on a section header.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function PlusIcon({ size = 18, color }: PlusIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M10 2.668c.367 0 .665.298.665.665v6.002h6.002a.665.665 0 0 1 0 1.33h-6.002v6.002a.665.665 0 0 1-1.33 0v-6.002H3.333a.665.665 0 0 1 0-1.33h6.002V3.333c0-.367.298-.665.665-.665"
        fill={tint}
      />
    </Svg>
  );
}
