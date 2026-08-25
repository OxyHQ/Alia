import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface SearchIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `search` — searching this conversation.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function SearchIcon({ size = 18, color }: SearchIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M9.162 2.38a6.707 6.707 0 0 1 5.155 10.993l3.243 3.243a.665.665 0 1 1-.94.94l-3.25-3.249A6.707 6.707 0 1 1 9.162 2.38m0 1.33a5.377 5.377 0 1 0 0 10.754 5.377 5.377 0 0 0 0-10.754"
        fill={tint}
      />
    </Svg>
  );
}
