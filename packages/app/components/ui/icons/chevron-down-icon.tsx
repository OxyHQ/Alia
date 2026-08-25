import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface ChevronDownIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `chevron-down-sm` — an expanded disclosure.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function ChevronDownIcon({ size = 18, color }: ChevronDownIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Path
        d="M12.629 5.879a.525.525 0 1 1 .742.742l-4.765 4.765a.86.86 0 0 1-1.212 0L2.629 6.62a.525.525 0 1 1 .742-.742L8 10.508z"
        fill={tint}
      />
    </Svg>
  );
}
