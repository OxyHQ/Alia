import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface GiftIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `gift` — the referral banner.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function GiftIcon({ size = 18, color }: GiftIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M16.002 10.665h-5.337v6.17h3.502A1.835 1.835 0 0 0 16.002 15zM3.998 15c0 1.013.822 1.835 1.835 1.835h3.502v-6.17H3.998zm12.837-6.667c0-.553-.449-1.001-1.002-1.001h-5.168v2.003h6.002a.17.17 0 0 0 .168-.168zm-13.67.834c0 .093.075.168.168.168h6.002V7.332H4.167c-.553 0-1.002.448-1.002 1.001zm6.17-4.584a1.418 1.418 0 1 0-1.418 1.419h1.418zm1.33 1.419h1.418a1.42 1.42 0 1 0-1.418-1.419zm4.167-1.419c0 .52-.147 1.005-.397 1.419h1.398a2.33 2.33 0 0 1 2.332 2.331v.834c0 .588-.34 1.095-.833 1.34V15a3.165 3.165 0 0 1-3.165 3.165H5.833A3.165 3.165 0 0 1 2.668 15v-4.493a1.5 1.5 0 0 1-.833-1.34v-.834a2.33 2.33 0 0 1 2.332-2.331h1.398c-.25-.414-.397-.9-.397-1.419A2.749 2.749 0 0 1 10 2.794a2.749 2.749 0 0 1 4.832 1.79"
        fill={tint}
      />
    </Svg>
  );
}
