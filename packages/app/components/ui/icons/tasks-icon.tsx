import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface TasksIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `tasks` — Tasks.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function TasksIcon({ size = 18, color }: TasksIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M4.89 10.946a3.193 3.193 0 1 1 0 6.386 3.193 3.193 0 0 1 0-6.386m0 1.33a1.863 1.863 0 1 0 0 3.725 1.863 1.863 0 0 0 0-3.725"
        fill={tint}
        fillRule="evenodd"
        clipRule="evenodd"
      />
      <Path
        d="M17.5 13.514a.666.666 0 0 1 0 1.33h-6.666a.665.665 0 0 1 0-1.33zM6.842 3.028a.666.666 0 0 1 1.198.563l-.058.122v.002l-.005.005-.012.022-.051.084c-.044.074-.11.18-.19.315L7.06 5.23c-.538.88-1.236 2.01-1.869 2.998a.915.915 0 0 1-1.437.131l-1.65-1.761a.665.665 0 0 1 .97-.91l1.282 1.369a200 200 0 0 0 2.23-3.605l.188-.312.051-.084q.008-.015.013-.02l.003-.007M17.5 5.166a.666.666 0 0 1 0 1.33h-6.666a.665.665 0 0 1 0-1.33z"
        fill={tint}
      />
    </Svg>
  );
}
