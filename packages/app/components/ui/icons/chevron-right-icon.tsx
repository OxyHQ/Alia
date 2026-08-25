import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface ChevronRightIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `chevron-right-sm` — a collapsed disclosure, and a row that leads somewhere.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function ChevronRightIcon({ size = 18, color }: ChevronRightIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Path
        d="M5.629 12.629a.525.525 0 1 0 .742.742l4.765-4.765a.86.86 0 0 0 0-1.212L6.37 2.629a.525.525 0 1 0-.742.742L10.258 8z"
        fill={tint}
      />
    </Svg>
  );
}
