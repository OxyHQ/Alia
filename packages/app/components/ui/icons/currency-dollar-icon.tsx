import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface CurrencyDollarIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `currency-dollar` — billing and usage.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function CurrencyDollarIcon({ size = 18, color }: CurrencyDollarIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 7.75v-1M12 16.25v1M9.5 15.08c2.5 1.724 5 .774 5-.797 0-2.707-5-1.757-5-4.463 0-1.572 2.5-2.523 4.5-1.18"
        fill="none"
        stroke={tint}
        strokeWidth={1.596}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M12 20.7a8.7 8.7 0 1 0 0-17.4 8.7 8.7 0 0 0 0 17.4Z"
        fill="none"
        stroke={tint}
        strokeWidth={1.596}
      />
    </Svg>
  );
}
