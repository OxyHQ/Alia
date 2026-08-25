import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface SidebarToggleIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `sidebar` — collapsing the sidebar to its rail and opening it again.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function SidebarToggleIcon({ size = 18, color }: SidebarToggleIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M14.5 2.877a3.665 3.665 0 0 1 3.665 3.665v6.917a3.665 3.665 0 0 1-3.665 3.665h-9a3.665 3.665 0 0 1-3.665-3.665V6.542A3.665 3.665 0 0 1 5.5 2.877zM8.165 15.794H14.5a2.335 2.335 0 0 0 2.335-2.335V6.542A2.335 2.335 0 0 0 14.5 4.207H8.165zM5.5 4.207a2.335 2.335 0 0 0-2.335 2.335v6.917A2.335 2.335 0 0 0 5.5 15.794h1.335V4.207z"
        fill={tint}
      />
    </Svg>
  );
}
