import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface DotsHorizontalIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `dots-horizontal` — the overflow menu on a row.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function DotsHorizontalIcon({ size = 18, color }: DotsHorizontalIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M4.167 8.501a1.499 1.499 0 1 1 0 2.998 1.499 1.499 0 0 1 0-2.998M10 8.501a1.499 1.499 0 1 1 0 2.998 1.499 1.499 0 0 1 0-2.998M15.834 8.501a1.5 1.5 0 1 1-.001 2.999 1.5 1.5 0 0 1 0-2.999"
        fill={tint}
      />
    </Svg>
  );
}
