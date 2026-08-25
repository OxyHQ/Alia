import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface MenuIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `menu` — the drawer trigger, on a screen too narrow for the sidebar.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function MenuIcon({ size = 18, color }: MenuIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M11.666 12.669a.665.665 0 0 1 0 1.33H3.333a.665.665 0 0 1 0-1.33zM16.666 6.002a.665.665 0 0 1 0 1.33H3.333a.665.665 0 0 1 0-1.33z"
        fill={tint}
      />
    </Svg>
  );
}
